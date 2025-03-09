from datetime import datetime
from bson.json_util import dumps
from flask import Flask, render_template, request, redirect, url_for, jsonify
from flask_login import current_user, login_user, login_required, logout_user, LoginManager
from flask_socketio import SocketIO, join_room, leave_room
from pymongo.errors import DuplicateKeyError
from passlib.hash import pbkdf2_sha256  # Cambio aquí

from db import get_user, save_user, get_rooms_for_user, get_room, is_room_member, get_room_members, add_room_members, \
    remove_room_members, update_room, is_room_admin, save_room, save_message, get_messages, leave_room_db

app = Flask(__name__)
app.secret_key = "sfdjkafnk"
socketio = SocketIO(app)
login_manager = LoginManager()
login_manager.login_view = 'login'
login_manager.init_app(app)

@app.route('/')
def home():
    rooms = []
    if current_user.is_authenticated:
        rooms = get_rooms_for_user(current_user.username)
    return render_template("index.html", rooms=rooms)


@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('home'))

    message = ''
    if request.method == 'POST':
        username = request.form.get('username')
        password_input = request.form.get('password')
        user = get_user(username)

        if user and user.check_password(password_input):
            login_user(user)
            return redirect(url_for('home'))
        else:
            message = 'Failed to login!'
    return render_template('login.html', message=message)


@app.route('/signup', methods=['GET', 'POST'])
def signup():
    if current_user.is_authenticated:
        return redirect(url_for('home'))

    message = ''
    if request.method == 'POST':
        username = request.form.get('username')
        email = request.form.get('email')
        password = request.form.get('password')
        try:
            save_user(username, email, password)
            return redirect(url_for('login'))
        except DuplicateKeyError:
            message = "User already exists!"
    return render_template('signup.html', message=message)


@app.route("/logout/")
@login_required
def logout():
    logout_user()
    return redirect(url_for('home'))


@app.route('/create-room/', methods=['GET', 'POST'])
@login_required
def create_room():
    message = ''
    if request.method == 'POST':
        room_name = request.form.get('room_name')
        usernames = [username.strip() for username in request.form.get('members').split(',')]

        if len(room_name) and len(usernames):
            room_id = save_room(room_name, current_user.username)
            if current_user.username in usernames:
                usernames.remove(current_user.username)
            add_room_members(room_id, room_name, usernames, current_user.username)
            return redirect(url_for('view_room', room_id=room_id))
        else:
            message = "Failed to create room"
    return render_template('create_room.html', message=message)


@app.route('/rooms/<room_id>/edit', methods=['GET', 'POST'])
@login_required
def edit_room(room_id):
    room = get_room(room_id)
    if room and is_room_admin(room_id, current_user.username):
        room_members = get_room_members(room_id)
        message = ''

        if request.method == 'POST':
            room_name = request.form.get('room_name')
            room['name'] = room_name
            update_room(room_id, room_name)

            new_members = [username.strip() for username in request.form.get('members').split(',')]
            existing_members = [member['_id']['username'] for member in room_members]

            # Remove members that are no longer in the list
            members_to_remove = list(set(existing_members) - set(new_members))
            if len(members_to_remove) and current_user.username not in members_to_remove:
                remove_room_members(room_id, members_to_remove)

            # Add new members
            members_to_add = list(set(new_members) - set(existing_members))
            if len(members_to_add):
                add_room_members(room_id, room_name, members_to_add, current_user.username)

            message = 'Room edited successfully'
            return redirect(url_for('view_room', room_id=room_id))

        return render_template('edit_room.html', room=room, room_members=room_members, message=message)
    else:
        return "Room not found", 404


@app.route('/check-users', methods=['POST'])
@login_required
def check_users():
    usernames = request.json.get('usernames', [])
    if not usernames:
        return jsonify({'valid': False, 'message': 'No usernames provided'})

    valid_users = []
    invalid_users = []

    for username in usernames:
        if get_user(username):
            valid_users.append(username)
        else:
            invalid_users.append(username)

    return jsonify({
        'valid': len(invalid_users) == 0,
        'valid_users': valid_users,
        'invalid_users': invalid_users,
        'message': f"Invalid users: {', '.join(invalid_users)}" if invalid_users else "All users are valid"
    })

@app.route('/rooms/<room_id>/')
@login_required
def view_room(room_id):
    room = get_room(room_id)
    if room and is_room_member(room_id, current_user.username):
        rooms = get_rooms_for_user(current_user.username)
        room_members = get_room_members(room_id)
        messages = get_messages(room_id)
        is_admin = is_room_admin(room_id, current_user.username)
        return render_template('index.html',
                             rooms=rooms,
                             active_room=room,
                             room_members=room_members,
                             messages=messages,
                             is_room_admin=is_admin)
    else:
        return "Room not found", 404

@app.route('/rooms/<room_id>/messages/')
@login_required
def get_older_messages(room_id):
    room = get_room(room_id)
    if room and is_room_member(room_id, current_user.username):
        page = int(request.args.get('page', 0))
        messages = get_messages(room_id, page)
        return dumps(messages)
    else:
        return "Room not found", 404


@socketio.on('send_message')
def handle_send_message_event(data):
    app.logger.info("{} has sent message to the room {}: {}".format(data['username'],
                                                                    data['room'],
                                                                    data['message']))
    data['created_at'] = datetime.now().strftime("%d %b, %H:%M")
    save_message(data['room'], data['message'], data['username'])
    socketio.emit('receive_message', data, room=data['room'])


@socketio.on('join_room')
def handle_join_room_event(data):
    app.logger.info("{} has joined the room {}".format(data['username'], data['room']))
    join_room(data['room'])
    socketio.emit('join_room_announcement', data, room=data['room'])

@app.route('/rooms/<room_id>/leave')
@login_required
def leave_room_route(room_id):
    room = get_room(room_id)
    if room and is_room_member(room_id, current_user.username):
        if is_room_admin(room_id, current_user.username):
            return "Los administradores no pueden abandonar las salas. Primero debes eliminar la sala o transferir los derechos de administrador.", 400
        else:
            
            save_message(room_id, f"{current_user.username} ha abandonado la sala",  "MENSAJE DEL SISTEMA")

            # Emit leave room event to all members
            socketio.emit('leave_room_announcement', 
                        {"username": current_user.username, "room": room_id}, 
                        room=room_id)

            # Remove user from the room
            leave_room_db(room_id, current_user.username)
            
            return redirect(url_for('home'))
    else:
        return "Room not found", 404

@socketio.on('leave_room')
def handle_leave_room_event(data):
    app.logger.info("{} ha abandonado la sala {}".format(data['username'], data['room']))
    leave_room(data['room'])
    socketio.emit('leave_room_announcement', data, room=data['room'])


@login_manager.user_loader
def load_user(username):
    return get_user(username)


if __name__ == '__main__':
    #Para que funcione con LOCALHOST
    socketio.run(app, debug=True)
    #Para que funcione con HAMACHI
    #socketio.run(app, host='0.0.0.0', port=5000, debug=True)
