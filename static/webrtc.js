// Variables globales para WebRTC
let localStream = null;
let peers = {};
let localVideo = null;
let remoteVideosContainer = null;
let currentRoom = null;
let peerConnections = {};
let myPeerId = null;
let isCallActive = false;
let iceCandidatesQueue = {};

// Configuración de ICE servers (STUN y TURN)
const iceConfiguration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Servidores TURN públicos gratuitos para pruebas
        { urls: 'turn:turn.conversant.im:3478', username: 'user', credential: 'pass' }
    ]
};

// Inicializar la videollamada
function initializeCall(roomId, username) {
    console.log(`Inicializando llamada en sala: ${roomId} como ${username}`);
    currentRoom = roomId;
    
    // Limpiar cualquier conexión previa
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    
    // Reiniciar variables
    peers = {};
    peerConnections = {};
    
    // Inicializar la interfaz
    setupUI();
    
    // Generar un ID único para este peer
    myPeerId = `${username}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    console.log(`Mi Peer ID generado: ${myPeerId}`);
    
    // Solicitar acceso a cámara y micrófono
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        .then(stream => {
            console.log('Stream local obtenido correctamente');
            localStream = stream;
            displayLocalVideo(stream);
            
            // Notificar al servidor que estamos listos para iniciar una llamada
            console.log('Emitiendo ready_to_call al servidor');
            socket.emit('ready_to_call', {
                room: roomId,
                username: username,
                peerId: myPeerId
            });
            
            // Mostrar la interfaz de llamada
            document.getElementById('video-container').style.display = 'flex';
            isCallActive = true;

            // Procesar cualquier conexión pendiente ahora que tenemos el stream
            console.log('Procesando conexiones pendientes...');
            for (const peerId in peers) {
                if (peers[peerId] && !peerConnections[peerId]) {
                    console.log(`Procesando conexión pendiente con: ${peerId}`);
                    createPeerConnection(peerId, true);
                }
            }
        })
        .catch(error => {
            console.error('Error al acceder a la cámara y micrófono:', error);
            showError('No se pudo acceder a tu cámara o micrófono. Por favor, verifica los permisos.');
        });
}

// Configurar la interfaz de usuario
function setupUI() {
    // Referencias a elementos del DOM
    localVideo = document.getElementById('local-video');
    remoteVideosContainer = document.getElementById('remote-videos');
    
    // Limpiar videos remotos anteriores
    remoteVideosContainer.innerHTML = '';
}

// Mostrar el video local
function displayLocalVideo(stream) {
    localVideo.srcObject = stream;
    localVideo.muted = true; // Silenciar el audio local para evitar eco
    localVideo.play().catch(error => console.error('Error reproduciendo video local:', error));
}

// Crear una conexión peer con otro usuario
function createPeerConnection(remotePeerId, isInitiator) {
    console.log(`Creando conexión peer con ${remotePeerId}, soy iniciador: ${isInitiator}`);

    // Verificar si ya existe una conexión
    if (peerConnections[remotePeerId]) {
        console.log(`Ya existe una conexión con ${remotePeerId}`);
        return peerConnections[remotePeerId];
    }

    // Verificar si el stream local está disponible
    if (!localStream) {
        console.error('Error: Intentando crear conexión sin stream local disponible');
        peers[remotePeerId] = true; // Guardar para procesamiento posterior
        return null;
    }
    
    // Crear una nueva conexión RTCPeerConnection
    const peerConnection = new RTCPeerConnection(iceConfiguration);
    peerConnections[remotePeerId] = peerConnection;
    
    // Agregar todas las pistas locales a la conexión
    localStream.getTracks().forEach(track => {
        console.log(`Agregando pista local a la conexión: ${track.kind}`);
        peerConnection.addTrack(track, localStream);
    });
    
    // Configurar el manejo de streams remotos
    peerConnection.ontrack = event => {
        console.log(`Recibida pista remota de ${remotePeerId}: ${event.track.kind}`);
        const stream = event.streams[0];
        if (!document.getElementById(`video-${remotePeerId}`)) {
            console.log(`Mostrando video remoto para ${remotePeerId}`);
            displayRemoteVideo(stream, remotePeerId);
        }
    };
    
    // Manejar candidatos ICE
    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            console.log(`Enviando candidato ICE a ${remotePeerId}`);
            socket.emit('ice_candidate', {
                room: currentRoom,
                peerId: myPeerId,
                targetPeerId: remotePeerId,
                candidate: event.candidate
            });
        }
    };
    
    // Eventos de conexión
    peerConnection.oniceconnectionstatechange = () => {
        const connectionState = peerConnection.iceConnectionState;
        console.log(`Estado de conexión ICE con ${remotePeerId}: ${connectionState}`);
        
        if (connectionState === 'failed' || connectionState === 'disconnected' || connectionState === 'closed') {
            console.log(`Limpiando conexión fallida con ${remotePeerId}`);
            cleanupPeerConnection(remotePeerId);
        }
    };
    
    // Agregar un temporizador para detectar conexiones fallidas
    const connectionTimeout = setTimeout(() => {
        if (peerConnection && (peerConnection.iceConnectionState === 'new' || 
                              peerConnection.iceConnectionState === 'checking')) {
            console.log(`Conexión con ${remotePeerId} no establecida después de 30 segundos. Limpiando.`);
            cleanupPeerConnection(remotePeerId);
        }
    }, 30000); // 30 segundos para establecer la conexión
    
    // Si somos el iniciador, creamos y enviamos la oferta
    if (isInitiator) {
        console.log(`Creando oferta para ${remotePeerId}`);
        peerConnection.createOffer()
            .then(offer => {
                console.log(`Estableciendo descripción local (oferta) para ${remotePeerId}`);
                return peerConnection.setLocalDescription(offer);
            })
            .then(() => {
                console.log(`Enviando oferta a ${remotePeerId}`);
                socket.emit('video_offer', {
                    room: currentRoom,
                    peerId: myPeerId,
                    targetPeerId: remotePeerId,
                    sdp: peerConnection.localDescription
                });
            })
            .catch(error => {
                console.error('Error creando oferta:', error);
                showError('Error al establecer la conexión de video');
            });
    }
    
    return peerConnection;
}

// Array para procesar mensajes ya recibidos
let processedSignalingMessages = {};

// Manejar una oferta de videollamada recibida
function handleVideoOffer(data) {
    const remotePeerId = data.peerId;
    console.log(`Recibida oferta de video de ${remotePeerId}`);
    
    // Verificar si este mensaje ya se procesó
    const messageId = `offer_${remotePeerId}_${Date.now()}`;
    if (processedSignalingMessages[messageId]) {
        console.log(`Mensaje de oferta duplicado ignorado: ${messageId}`);
        return;
    }
    processedSignalingMessages[messageId] = true;
    
    // Crear una conexión peer si no existe
    if (!peerConnections[remotePeerId]) {
        console.log(`Creando nueva conexión para la oferta de ${remotePeerId}`);
        createPeerConnection(remotePeerId, false);
    }
    
    const peerConnection = peerConnections[remotePeerId];
    if (!peerConnection) {
        console.error(`No se pudo crear la conexión para ${remotePeerId}`);
        return;
    }
    
    // Establecer la descripción remota
    console.log(`Estableciendo descripción remota (oferta) para ${remotePeerId}`);
    peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp))
        .then(() => {
            console.log(`Creando respuesta para ${remotePeerId}`);
            return peerConnection.createAnswer();
        })
        .then(answer => {
            console.log(`Estableciendo descripción local (respuesta) para ${remotePeerId}`);
            return peerConnection.setLocalDescription(answer);
        })
        .then(() => {
            console.log(`Enviando respuesta a ${remotePeerId}`);
            socket.emit('video_answer', {
                room: currentRoom,
                peerId: myPeerId,
                targetPeerId: remotePeerId,
                sdp: peerConnection.localDescription
            });
            
            // Procesar candidatos ICE pendientes
            if (iceCandidatesQueue[remotePeerId] && iceCandidatesQueue[remotePeerId].length > 0) {
                console.log(`Procesando ${iceCandidatesQueue[remotePeerId].length} candidatos ICE pendientes para ${remotePeerId}`);
                iceCandidatesQueue[remotePeerId].forEach(candidate => {
                    peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                        .catch(error => {
                            console.error('Error añadiendo candidato ICE pendiente:', error);
                        });
                });
                iceCandidatesQueue[remotePeerId] = [];
            }
        })
        .catch(error => {
            console.error('Error respondiendo a la oferta:', error);
            showError('Error al establecer la conexión de video');
        });
}

// Manejar una respuesta a nuestra oferta de videollamada
function handleVideoAnswer(data) {
    const remotePeerId = data.peerId;
    console.log(`Recibida respuesta de video de ${remotePeerId}`);
    
    const peerConnection = peerConnections[remotePeerId];
    if (!peerConnection) {
        console.error(`Recibida respuesta pero no existe conexión para ${remotePeerId}`);
        return;
    }
    
    // Verificar el estado de la conexión antes de establecer la descripción remota
    if (peerConnection.signalingState !== "stable") {
        console.log(`Estableciendo descripción remota (respuesta) para ${remotePeerId}`);
        peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp))
            .then(() => {
                console.log(`Descripción remota establecida para ${remotePeerId}`);
                
                // Procesar candidatos ICE pendientes
                if (iceCandidatesQueue[remotePeerId] && iceCandidatesQueue[remotePeerId].length > 0) {
                    console.log(`Procesando ${iceCandidatesQueue[remotePeerId].length} candidatos ICE pendientes para ${remotePeerId}`);
                    iceCandidatesQueue[remotePeerId].forEach(candidate => {
                        peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                            .catch(error => {
                                console.error('Error añadiendo candidato ICE pendiente:', error);
                            });
                    });
                    iceCandidatesQueue[remotePeerId] = [];
                }
            })
            .catch(error => {
                console.error('Error estableciendo respuesta remota:', error);
                showError('Error al establecer la conexión de video');
            });
    } else {
        console.log(`Ignorando respuesta para ${remotePeerId} porque la conexión ya está en estado estable`);
    }
}

// Manejar un candidato ICE recibido
function handleIceCandidate(data) {
    const remotePeerId = data.peerId;
    console.log(`Recibido candidato ICE de ${remotePeerId}`);
    
    if (remotePeerId === myPeerId) {
        console.log('Ignorando candidato ICE propio');
        return;
    }
    
    const peerConnection = peerConnections[remotePeerId];
    
    if (peerConnection) {
        // Verificar si la descripción remota ya está establecida
        if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
            console.log(`Añadiendo candidato ICE para ${remotePeerId}`);
            peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate))
                .catch(error => {
                    console.error('Error añadiendo candidato ICE:', error);
                });
        } else {
            // Guardar el candidato para procesarlo después
            if (!iceCandidatesQueue[remotePeerId]) {
                iceCandidatesQueue[remotePeerId] = [];
            }
            iceCandidatesQueue[remotePeerId].push(data.candidate);
            console.log(`Candidato ICE en cola para ${remotePeerId} porque remoteDescription es null`);
        }
    } else {
        console.log(`No hay conexión para ${remotePeerId}, guardando el candidato ICE para más tarde`);
        if (!iceCandidatesQueue[remotePeerId]) {
            iceCandidatesQueue[remotePeerId] = [];
        }
        iceCandidatesQueue[remotePeerId].push(data.candidate);
        
        // Si no tenemos una conexión para este peer, creamos una
        if (!peerConnections[remotePeerId]) {
            console.log(`Creando conexión para ${remotePeerId} después de recibir candidato ICE`);
            createPeerConnection(remotePeerId, false);
        }
    }
}

// Mostrar video remoto en la interfaz
function displayRemoteVideo(stream, peerId) {
    console.log(`Mostrando video remoto para ${peerId}`);
    
    // Verificar si ya existe un video para este peer
    if (document.getElementById(`video-${peerId}`)) {
        console.log(`Ya existe un video para ${peerId}`);
        return;
    }
    
    const videoElement = document.createElement('video');
    videoElement.id = `video-${peerId}`;
    videoElement.srcObject = stream;
    videoElement.classList.add('remote-video');
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    
    const videoContainer = document.createElement('div');
    videoContainer.classList.add('remote-video-container');
    videoContainer.id = `container-${peerId}`;
    
    // Etiqueta con el nombre (extraer del peerId)
    const nameLabel = document.createElement('div');
    nameLabel.classList.add('video-username');
    nameLabel.textContent = peerId.split('_')[0]; // Asumiendo formato username_timestamp
    
    videoContainer.appendChild(videoElement);
    videoContainer.appendChild(nameLabel);
    remoteVideosContainer.appendChild(videoContainer);
    
    // Intentar reproducir el video
    videoElement.play().catch(error => {
        console.error(`Error reproduciendo video remoto para ${peerId}:`, error);
    });
    
    console.log(`Video remoto agregado para ${peerId}`);
}

// Limpiar una conexión peer
function cleanupPeerConnection(peerId) {
    console.log(`Limpiando conexión con ${peerId}`);
    
    if (peerConnections[peerId]) {
        peerConnections[peerId].close();
        delete peerConnections[peerId];
    }
    
    // Eliminar el elemento de video si existe
    const videoContainer = document.getElementById(`container-${peerId}`);
    if (videoContainer) {
        videoContainer.remove();
    }
}

// Finalizar la videollamada
function endCall() {
    console.log('Finalizando videollamada');
    isCallActive = false;
    
    // Detener todas las pistas de medios locales
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    // Cerrar todas las conexiones peer
    for (const peerId in peerConnections) {
        cleanupPeerConnection(peerId);
    }
    
    // Ocultar la interfaz de videollamada
    document.getElementById('video-container').style.display = 'none';
    
    // Notificar que salimos de la llamada
    socket.emit('leave_call', {
        room: currentRoom,
        peerId: myPeerId
    });
    
    // Limpiar variables
    peerConnections = {};
    peers = {};
    currentRoom = null;
    myPeerId = null;
}

// Mostrar un mensaje de error
function showError(message) {
    console.error(message);
    const errorDiv = document.getElementById('call-error');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    
    // Ocultar después de 5 segundos
    setTimeout(() => {
        errorDiv.style.display = 'none';
    }, 5000);
}

// Función para iniciar una videollamada
function startVideoCall() {
    const roomId = document.getElementById('room-id').value;
    const username = document.getElementById('current-username').value;
    
    console.log(`Iniciando videollamada en sala ${roomId} como ${username}`);
    
    // Verificar si ya hay una llamada activa
    if (isCallActive) {
        showError('Ya hay una videollamada activa. Por favor, finalízala antes de iniciar una nueva.');
        return;
    }
    
    // Mostrar la interfaz de confirmación
    document.getElementById('call-confirmation').style.display = 'flex';
}

// Función para confirmar el inicio de la videollamada
function confirmVideoCall() {
    const roomId = document.getElementById('room-id').value;
    const username = document.getElementById('current-username').value;
    
    // Ocultar confirmación
    document.getElementById('call-confirmation').style.display = 'none';
    
    // Iniciar la videollamada
    initializeCall(roomId, username);
    
    // Notificar a otros usuarios en la sala
    socket.emit('video_call_started', {
        room: roomId,
        username: username
    });
}

// Función para cancelar la confirmación
function cancelVideoCall() {
    document.getElementById('call-confirmation').style.display = 'none';
}

// Función para manejar videollamada entrante
function handleIncomingCall(data) {
    // Verificar si ya hay una llamada activa
    if (isCallActive) {
        return;
    }
    
    const callerUsername = data.username;
    const roomId = data.room;
    
    console.log(`Llamada entrante de ${callerUsername} en sala ${roomId}`);
    
    // Mostrar notificación de llamada entrante
    document.getElementById('caller-name').textContent = callerUsername;
    document.getElementById('incoming-call').style.display = 'flex';
    
    // Reproducir sonido de llamada
    const ringtone = document.getElementById('ringtone');
    if (ringtone.src === '') {
        console.warn('El archivo de tono de llamada no está disponible');
        // Usar un tono de reserva
        ringtone.src = 'data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU...';
    }
    ringtone.play().catch(e => console.log('Error reproduciendo tono de llamada:', e));
}

// Función para aceptar llamada entrante
function acceptCall() {
    const roomId = document.getElementById('room-id').value;
    const username = document.getElementById('current-username').value;
    
    console.log(`Aceptando llamada en sala ${roomId} como ${username}`);
    
    // Ocultar notificación
    document.getElementById('incoming-call').style.display = 'none';
    
    // Detener sonido
    document.getElementById('ringtone').pause();
    
    // Iniciar videollamada
    initializeCall(roomId, username);
}

// Función para rechazar llamada entrante
function rejectCall() {
    document.getElementById('incoming-call').style.display = 'none';
    document.getElementById('ringtone').pause();
    
    const roomId = document.getElementById('room-id').value;
    const username = document.getElementById('current-username').value;
    
    console.log(`Rechazando llamada en sala ${roomId} como ${username}`);
    
    // Notificar rechazo
    socket.emit('call_rejected', {
        room: roomId,
        username: username
    });
}

// Función para manejar cuando otro usuario se une a la llamada
function handleUserJoined(data) {
    const remotePeerId = data.peerId;
    
    console.log(`Usuario ${data.username} (${remotePeerId}) se unió a la llamada`);
    
    // Verificar si localStream está disponible antes de crear la conexión
    if (localStream) {
        console.log(`Stream local disponible, creando conexión con ${remotePeerId}`);
        // Iniciar conexión si no existe
        if (!peerConnections[remotePeerId]) {
            createPeerConnection(remotePeerId, true);
        }
    } else {
        // Si localStream no está disponible, guardar el peerId para procesarlo después
        console.log(`Stream local no disponible. Guardando ${remotePeerId} para conectar más tarde`);
        peers[remotePeerId] = true;
    }
}

// Función para manejar cuando otro usuario deja la llamada
function handleUserLeft(data) {
    const remotePeerId = data.peerId;
    console.log(`Usuario ${remotePeerId} dejó la llamada`);
    cleanupPeerConnection(remotePeerId);
}

// Función para silenciar/activar micrófono
function toggleMute() {
    if (localStream) {
        const audioTracks = localStream.getAudioTracks();
        if (audioTracks.length > 0) {
            const isMuted = !audioTracks[0].enabled;
            audioTracks[0].enabled = isMuted;
            
            // Actualizar botón
            const muteBtn = document.getElementById('mute-btn');
            muteBtn.textContent = isMuted ? 'Silenciar' : 'Activar Micrófono';
            console.log(`Micrófono ${isMuted ? 'activado' : 'silenciado'}`);
        }
    }
}

// Función para encender/apagar cámara
function toggleVideo() {
    if (localStream) {
        const videoTracks = localStream.getVideoTracks();
        if (videoTracks.length > 0) {
            const isVideoOn = !videoTracks[0].enabled;
            videoTracks[0].enabled = isVideoOn;
            
            // Actualizar botón
            const videoBtn = document.getElementById('video-btn');
            videoBtn.textContent = isVideoOn ? 'Apagar Cámara' : 'Encender Cámara';
            
            // Mostrar u ocultar overlay en video local
            const videoOverlay = document.getElementById('local-video-overlay');
            if (videoOverlay) {
                videoOverlay.style.display = isVideoOn ? 'none' : 'flex';
            }
            
            console.log(`Cámara ${isVideoOn ? 'encendida' : 'apagada'}`);
        }
    }
}

// Configurar event listeners de Socket.IO para videollamadas
function setupCallEventListeners() {
    socket.on('user_ready_to_call', handleUserJoined);
    socket.on('video_offer', handleVideoOffer);
    socket.on('video_answer', handleVideoAnswer);
    socket.on('ice_candidate', handleIceCandidate);
    socket.on('user_left_call', handleUserLeft);
    socket.on('video_call_started', handleIncomingCall);
    socket.on('call_rejected', data => {
        showError(`${data.username} rechazó la llamada`);
    });
    
    console.log('Event listeners de videollamada configurados');
}

// Inicializar al cargar la página
document.addEventListener('DOMContentLoaded', function() {
    // Solo configurar si estamos en una sala
    if (document.getElementById('room-id')) {
        console.log('Configurando videollamada para la sala');
        setupCallEventListeners();
    }
});