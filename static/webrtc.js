console.log("webrtc.js cargado correctamente");

class WebRTCClient {
    constructor(socket, username, roomId) {
        this.socket = socket;
        this.username = username;
        this.roomId = roomId;
        this.peerConnections = {};
        this.localStream = null;
        this.iceServers = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };

        // DOM elements
        this.videoModal = document.getElementById('video-modal');
        this.localVideo = document.getElementById('local-video');
        this.remoteVideosContainer = document.getElementById('remote-videos');
        this.toggleAudioBtn = document.getElementById('toggle-audio-btn');
        this.toggleVideoBtn = document.getElementById('toggle-video-btn');
        this.closeVideoBtn = document.getElementById('close-video-btn');
        this.videoCallBtn = document.getElementById('video-call-btn');

        // Bind methods
        this.startCall = this.startCall.bind(this);
        this.stopCall = this.stopCall.bind(this);
        this.toggleAudio = this.toggleAudio.bind(this);
        this.toggleVideo = this.toggleVideo.bind(this);
        this.handleIceCandidate = this.handleIceCandidate.bind(this);
        this.handleNegotiationNeeded = this.handleNegotiationNeeded.bind(this);
        this.handleRemoteTrack = this.handleRemoteTrack.bind(this);
        this.createPeerConnection = this.createPeerConnection.bind(this);

        // Setup event listeners
        this.setupEventListeners();
    }

    // Set up UI event listeners
    setupEventListeners() {
        this.videoCallBtn.addEventListener('click', this.startCall);
        this.closeVideoBtn.addEventListener('click', this.stopCall);
        this.toggleAudioBtn.addEventListener('click', this.toggleAudio);
        this.toggleVideoBtn.addEventListener('click', this.toggleVideo);

        // Socket events for signaling
        this.socket.on('video_offer', async (data) => {
            if (data.target === this.username) {
                const caller = data.caller;
                const offer = data.offer;
                
                // Create answer for the offer
                const pc = this.createPeerConnection(caller);
                await pc.setRemoteDescription(new RTCSessionDescription(offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                
                this.socket.emit('video_answer', {
                    caller: caller,
                    target: this.username,
                    answer: answer
                });

                // Show call notification if not already in call
                if (!this.localStream) {
                    if (confirm(`${caller} te está llamando. ¿Aceptar videollamada?`)) {
                        this.startCall(null, true);
                    } else {
                        this.socket.emit('video_reject', {
                            caller: caller,
                            target: this.username
                        });
                        this.closePeerConnection(caller);
                    }
                }
            }
        });

        this.socket.on('video_answer', async (data) => {
            if (data.target === this.username && this.peerConnections[data.caller]) {
                const pc = this.peerConnections[data.caller];
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            }
        });

        this.socket.on('video_ice_candidate', (data) => {
            if (data.target === this.username && this.peerConnections[data.caller]) {
                const pc = this.peerConnections[data.caller];
                const candidate = new RTCIceCandidate({
                    sdpMLineIndex: data.candidate.sdpMLineIndex,
                    candidate: data.candidate.candidate
                });
                pc.addIceCandidate(candidate).catch(e => console.error('Error adding ice candidate', e));
            }
        });

        this.socket.on('video_call_rejected', (data) => {
            if (data.caller === this.username) {
                alert(`${data.target} rechazó tu videollamada`);
                this.closePeerConnection(data.target);
            }
        });

        this.socket.on('user_disconnected', (data) => {
            if (this.peerConnections[data.username]) {
                this.removeVideoElement(data.username);
                this.closePeerConnection(data.username);
            }
        });

        this.socket.on('join_video_room', (data) => {
            if (data.username !== this.username && this.localStream) {
                // Someone joined while we're in a call, send them an offer
                this.sendVideoOffer(data.username);
            }
        });
    }

    // Start a video call
    async startCall(event, isReceivingCall = false) {
        try {
            // Get user media
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            
            // Display local video
            this.localVideo.srcObject = this.localStream;
            this.videoModal.style.display = 'block';
            
            // Notify server about joining video room
            this.socket.emit('join_video_room', {
                username: this.username,
                room: this.roomId
            });
            
            // If we're starting the call (not receiving), send offers to room members
            if (!isReceivingCall) {
                // Get active room members
                fetch(`/rooms/${this.roomId}/members`)
                    .then(res => res.json())
                    .then(members => {
                        // Send offer to each room member
                        members.forEach(member => {
                            if (member.username !== this.username) {
                                this.sendVideoOffer(member.username);
                            }
                        });
                    })
                    .catch(err => console.error('Error fetching room members:', err));
            }
        } catch (error) {
            console.error('Error starting call:', error);
            alert('No se pudo acceder a la cámara o el micrófono. Por favor, comprueba los permisos.');
        }
    }
    
    // Send video offer to a peer
    async sendVideoOffer(targetUsername) {
        try {
            const pc = this.createPeerConnection(targetUsername);
            
            // Add local tracks to peer connection
            this.localStream.getTracks().forEach(track => {
                pc.addTrack(track, this.localStream);
            });
            
            // Create and send offer
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            
            this.socket.emit('video_offer', {
                caller: this.username,
                target: targetUsername,
                offer: offer
            });
        } catch (error) {
            console.error('Error sending video offer:', error);
        }
    }

    // Handle ICE candidates
    handleIceCandidate(event, target) {
        if (event.candidate) {
            this.socket.emit('video_ice_candidate', {
                caller: this.username,
                target: target,
                candidate: {
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                    candidate: event.candidate.candidate
                }
            });
        }
    }

    // Handle negotiation needed event
    async handleNegotiationNeeded(event, target) {
        try {
            const pc = this.peerConnections[target];
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            
            this.socket.emit('video_offer', {
                caller: this.username,
                target: target,
                offer: pc.localDescription
            });
        } catch (error) {
            console.error('Error during negotiation:', error);
        }
    }

    // Handle remote tracks
    handleRemoteTrack(event, username) {
        if (event.streams && event.streams[0]) {
            this.setupRemoteVideo(username, event.streams[0]);
        }
    }

    // Create a new RTCPeerConnection
    createPeerConnection(username) {
        if (this.peerConnections[username]) {
            return this.peerConnections[username];
        }
        
        const pc = new RTCPeerConnection(this.iceServers);
        
        // Setup event handlers
        pc.onicecandidate = (event) => this.handleIceCandidate(event, username);
        pc.onnegotiationneeded = (event) => this.handleNegotiationNeeded(event, username);
        pc.ontrack = (event) => this.handleRemoteTrack(event, username);
        
        // Store the connection
        this.peerConnections[username] = pc;
        
        return pc;
    }
    
    // Setup remote video element
    setupRemoteVideo(username, stream) {
        // Check if element already exists
        let videoElement = document.getElementById(`video-${username}`);
        
        if (!videoElement) {
            // Create container for the remote video
            const videoItem = document.createElement('div');
            videoItem.className = 'video-item';
            videoItem.id = `video-container-${username}`;
            
            // Create video element
            videoElement = document.createElement('video');
            videoElement.id = `video-${username}`;
            videoElement.autoplay = true;
            videoElement.playsinline = true;
            
            // Create label
            const label = document.createElement('div');
            label.className = 'video-label';
            label.textContent = username;
            
            // Append elements
            videoItem.appendChild(videoElement);
            videoItem.appendChild(label);
            this.remoteVideosContainer.appendChild(videoItem);
        }
        
        // Set the stream as source
        videoElement.srcObject = stream;
    }
    
    // Remove a video element
    removeVideoElement(username) {
        const container = document.getElementById(`video-container-${username}`);
        if (container) {
            container.remove();
        }
    }
    
    // Close a peer connection
    closePeerConnection(username) {
        if (this.peerConnections[username]) {
            this.peerConnections[username].close();
            delete this.peerConnections[username];
        }
    }
    
    // Stop the call
    stopCall() {
        // Close all peer connections
        Object.keys(this.peerConnections).forEach(username => {
            this.closePeerConnection(username);
        });
        
        // Stop local stream tracks
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        
        // Clear remote videos
        this.remoteVideosContainer.innerHTML = '';
        
        // Hide modal
        this.videoModal.style.display = 'none';
        
        // Notify server
        this.socket.emit('leave_video_room', {
            username: this.username,
            room: this.roomId
        });
    }
    
    // Toggle audio
    toggleAudio() {
        if (this.localStream) {
            const audioTracks = this.localStream.getAudioTracks();
            
            if (audioTracks.length > 0) {
                const enabled = !audioTracks[0].enabled;
                audioTracks[0].enabled = enabled;
                
                // Update button UI
                this.toggleAudioBtn.textContent = enabled ? 'Silenciar' : 'Activar Micrófono';
                this.toggleAudioBtn.classList.toggle('btn-disabled', !enabled);
            }
        }
    }
    
    // Toggle video
    toggleVideo() {
        if (this.localStream) {
            const videoTracks = this.localStream.getVideoTracks();
            
            if (videoTracks.length > 0) {
                const enabled = !videoTracks[0].enabled;
                videoTracks[0].enabled = enabled;
                
                // Update button UI
                this.toggleVideoBtn.textContent = enabled ? 'Apagar Cámara' : 'Activar Cámara';
                this.toggleVideoBtn.classList.toggle('btn-disabled', !enabled);
                
                // Show placeholder when video is off
                if (!enabled) {
                    const placeholder = document.createElement('div');
                    placeholder.className = 'user-video-off';
                    placeholder.textContent = 'Cámara apagada';
                    placeholder.id = 'local-video-off';
                    
                    const videoContainer = this.localVideo.parentElement;
                    videoContainer.appendChild(placeholder);
                } else {
                    const placeholder = document.getElementById('local-video-off');
                    if (placeholder) {
                        placeholder.remove();
                    }
                }
            }
        }
    }
}