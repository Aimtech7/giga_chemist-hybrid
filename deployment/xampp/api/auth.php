<?php
/**
 * GIGA CHEMIST - Local Authentication & RBAC Engine
 * Compatible with PHP 5.4+ through PHP 8.3+
 */

require_once __DIR__ . '/db.php';

function handleLogin() {
    $body = getJsonBody();
    $login = trim(giga_get($body, 'username', giga_get($body, 'email', '')));
    $password = trim(giga_get($body, 'password', giga_get($body, 'pin', '')));

    if (empty($login) || empty($password)) {
        jsonResponse(array('error' => 'Username/Email and password are required'), 400);
    }

    $pdo = getDb();
    $stmt = $pdo->prepare('SELECT * FROM `users` WHERE (`email` = :login OR `name` = :login) AND `active` = 1 LIMIT 1');
    $stmt->execute(array(':login' => $login));
    $user = $stmt->fetch();

    if (!$user) {
        jsonResponse(array('error' => 'Invalid credentials or inactive account'), 401);
    }

    if (!verifyLocalPassword($password, $user['password_hash'])) {
        jsonResponse(array('error' => 'Invalid credentials'), 401);
    }

    // Update last_login
    $now = date('Y-m-d H:i:s');
    $upd = $pdo->prepare('UPDATE `users` SET `last_login` = :now WHERE `id` = :id');
    $upd->execute(array(':now' => $now, ':id' => $user['id']));

    // Fetch user permissions
    $permStmt = $pdo->prepare('
        SELECT p.code 
        FROM permissions p
        JOIN role_permissions rp ON p.id = rp.permission_id
        JOIN roles r ON rp.role_id = r.id
        WHERE r.name = :role
    ');
    $permStmt->execute(array(':role' => $user['role']));
    $permissions = $permStmt->fetchAll(PDO::FETCH_COLUMN);

    // Create session token payload
    $token = base64_encode(json_encode(array(
        'user_id'     => $user['id'],
        'role'        => $user['role'],
        'name'        => $user['name'],
        'email'       => $user['email'],
        'time'        => time(),
    )));

    jsonResponse(array(
        'user' => array(
            'id'         => $user['id'],
            'name'       => $user['name'],
            'email'      => $user['email'],
            'role'       => $user['role'],
            'phone'      => $user['phone'],
            'active'     => (bool)$user['active'],
            'created_at' => $user['created_at'],
            'last_login' => $now,
        ),
        'token'       => $token,
        'permissions' => $permissions,
    ));
}

function getCurrentUserRole() {
    // Check custom header from frontend or auth token
    if (!empty($_SERVER['HTTP_X_USER_ROLE'])) {
        return strtoupper($_SERVER['HTTP_X_USER_ROLE']);
    }

    if (!empty($_SERVER['HTTP_AUTHORIZATION'])) {
        $auth = $_SERVER['HTTP_AUTHORIZATION'];
        if (preg_match('/Bearer\s+(.*)$/i', $auth, $matches)) {
            $payload = json_decode(base64_decode($matches[1]), true);
            if (!empty($payload['role'])) {
                return strtoupper($payload['role']);
            }
        }
    }

    return null;
}

function requireRole($allowedRoles) {
    $role = getCurrentUserRole();
    if (!$role || !in_array($role, (array)$allowedRoles, true)) {
        jsonResponse(array('error' => 'Unauthorized: Insufficient permissions for this action'), 403);
    }
}
