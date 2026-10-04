<?php
/**
 * GIGA CHEMIST - First Administrator Bootstrap Script
 * Allows secure creation of the initial system Administrator.
 * 
 * Usage CLI:
 *   php create-admin.php
 * 
 * Usage Browser:
 *   http://localhost/giga-chemist/scripts/create-admin.php
 * 
 * Compatible with PHP 5.4+ through PHP 8.3+
 */

require_once __DIR__ . '/../api/db.php';

$isCli = (php_sapi_name() === 'cli');
$message = '';
$error = '';
$adminExists = false;

try {
    $pdo = getDb();
    $stmt = $pdo->query("SELECT COUNT(*) FROM `users` WHERE `role` = 'ADMIN' AND `active` = 1");
    $adminCount = $stmt->fetchColumn();
    if ($adminCount > 0) {
        $adminExists = true;
    }
} catch (Exception $e) {
    // Database might not be migrated yet
}

if ($isCli) {
    echo "========================================================\n";
    echo " GIGA CHEMIST - First Administrator Bootstrap\n";
    echo "========================================================\n\n";

    if ($adminExists && (!isset($argv[1]) || $argv[1] !== '--force')) {
        echo "[NOTICE] An active Administrator account already exists in the database.\n";
        echo "If you need to reconfigure or create another user, please log into GIGA CHEMIST\n";
        echo "and navigate to User Management, or run: php create-admin.php --force\n";
        exit(0);
    }

    echo "Enter Administrator Full Name (e.g., Dr. Jane Doe): ";
    $name = trim(fgets(STDIN));
    if (empty($name)) $name = 'Administrator';

    echo "Enter Administrator Email / Username (e.g., admin@gigachemist.co.ke): ";
    $email = trim(fgets(STDIN));
    if (empty($email)) {
        echo "Error: Email/Username cannot be empty.\n";
        exit(1);
    }

    echo "Enter Administrator Password (min 6 characters): ";
    $password = trim(fgets(STDIN));
    if (strlen($password) < 6) {
        echo "Error: Password must be at least 6 characters long.\n";
        exit(1);
    }

    echo "Enter Phone Number (optional): ";
    $phone = trim(fgets(STDIN));

    createAdminUser($name, $email, $password, $phone);
    echo "\n[SUCCESS] Administrator account '{$email}' bootstrapped successfully!\n";
    echo "You can now login at: http://localhost/giga-chemist/\n";
    exit(0);
}

// Web Request Handling
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $name = trim(isset($_POST['name']) ? $_POST['name'] : '');
    $email = trim(isset($_POST['email']) ? $_POST['email'] : '');
    $password = trim(isset($_POST['password']) ? $_POST['password'] : '');
    $phone = trim(isset($_POST['phone']) ? $_POST['phone'] : '');

    if ($adminExists && empty($_POST['confirm_override'])) {
        $error = 'An Administrator already exists. To create another user, log in and use User Management, or check the confirmation box below.';
    } elseif (empty($email) || empty($password)) {
        $error = 'Email/Username and password are required.';
    } elseif (strlen($password) < 6) {
        $error = 'Password must be at least 6 characters.';
    } else {
        try {
            createAdminUser($name ? $name : 'Administrator', $email, $password, $phone);
            $message = "Administrator '{$email}' created successfully! You can now log into GIGA CHEMIST.";
            $adminExists = true;
        } catch (Exception $e) {
            $error = "Error: " . $e->getMessage();
        }
    }
}

function createAdminUser($name, $email, $password, $phone = '') {
    $pdo = getDb();
    $userId = 'usr-admin-' . time();
    $hash = hashLocalPassword($password);
    $now = date('Y-m-d H:i:s');

    // Check if user already exists
    $check = $pdo->prepare('SELECT `id` FROM `users` WHERE `email` = :email LIMIT 1');
    $check->execute(array(':email' => $email));
    $existing = $check->fetch();

    if ($existing) {
        // Update password and ensure active ADMIN
        $stmt = $pdo->prepare('
            UPDATE `users` 
            SET `name` = :name, `password_hash` = :hash, `role` = "ADMIN", `active` = 1, `phone` = :phone
            WHERE `id` = :id
        ');
        $stmt->execute(array(
            ':name'  => $name,
            ':hash'  => $hash,
            ':phone' => $phone ? $phone : null,
            ':id'    => $existing['id']
        ));
        $targetId = $existing['id'];
    } else {
        $stmt = $pdo->prepare('
            INSERT INTO `users` (id, branch_id, name, email, password_hash, role, phone, active, created_at)
            VALUES (:id, "branch-kitale", :name, :email, :hash, "ADMIN", :phone, 1, :now)
        ');
        $stmt->execute(array(
            ':id'    => $userId,
            ':name'  => $name,
            ':email' => $email,
            ':hash'  => $hash,
            ':phone' => $phone ? $phone : null,
            ':now'   => $now,
        ));
        $targetId = $userId;
    }

    // Ensure role assignment in user_roles
    $urStmt = $pdo->prepare('
        INSERT INTO `user_roles` (id, user_id, role_id)
        VALUES (:id, :uid, "role-admin")
        ON DUPLICATE KEY UPDATE `role_id` = "role-admin"
    ');
    $urStmt->execute(array(
        ':id'  => 'ur-' . $targetId,
        ':uid' => $targetId
    ));

    // Record audit log
    $audStmt = $pdo->prepare('
        INSERT INTO `audit_logs` (id, user_id, user_name, role, action, entity, entity_id, new_value, date, timestamp, created_at)
        VALUES (:id, :uid, :uname, "ADMIN", "USER_ADMIN_BOOTSTRAPPED", "user", :uid, :val, :date, :ts, :now)
    ');
    $audStmt->execute(array(
        ':id'    => 'aud-boot-' . time(),
        ':uid'   => $targetId,
        ':uname' => $name,
        ':val'   => json_encode(array('email' => $email, 'role' => 'ADMIN')),
        ':date'  => date('Y-m-d'),
        ':ts'    => time(),
        ':now'   => $now,
    ));
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GIGA CHEMIST - First Administrator Setup</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
        .box { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; max-width: 450px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); }
        h1 { font-size: 20px; margin-top: 0; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
        label { display: block; font-size: 13px; font-weight: 600; color: #94a3b8; margin-bottom: 6px; }
        input[type="text"], input[type="password"] { width: 100%; box-sizing: border-box; padding: 10px 12px; background: #0f172a; border: 1px solid #475569; border-radius: 6px; color: #fff; font-size: 14px; margin-bottom: 16px; }
        input:focus { outline: none; border-color: #38bdf8; }
        button { width: 100%; background: #0284c7; color: #fff; border: none; padding: 12px; font-weight: bold; border-radius: 6px; font-size: 14px; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #0369a1; }
        .alert { padding: 12px; border-radius: 6px; font-size: 13px; margin-bottom: 20px; }
        .alert-success { background: #064e3b; border: 1px solid #059669; color: #a7f3d0; }
        .alert-error { background: #7f1d1d; border: 1px solid #dc2626; color: #fecaca; }
        .alert-info { background: #1e3a8a; border: 1px solid #3b82f6; color: #bfdbfe; }
        .links { margin-top: 20px; text-align: center; font-size: 13px; }
        .links a { color: #38bdf8; text-decoration: none; }
    </style>
</head>
<body>
    <div class="box">
        <h1>🏥 GIGA CHEMIST Setup</h1>
        <p style="font-size: 13px; color: #cbd5e1; margin-bottom: 24px;">Create your primary system Administrator account for offline POS management.</p>

        <?php if (!empty($message)): ?>
            <div class="alert alert-success">
                <?= htmlspecialchars($message) ?>
                <div style="margin-top: 10px;">
                    <a href="../" style="color: #38bdf8; font-weight: bold;">&rarr; Open GIGA CHEMIST POS</a>
                </div>
            </div>
        <?php endif; ?>

        <?php if (!empty($error)): ?>
            <div class="alert alert-error"><?= htmlspecialchars($error) ?></div>
        <?php endif; ?>

        <?php if ($adminExists && empty($message)): ?>
            <div class="alert alert-info">
                ℹ️ An active Administrator account is already registered.
            </div>
        <?php endif; ?>

        <form method="POST">
            <div>
                <label>Admin Full Name</label>
                <input type="text" name="name" placeholder="Dr. Jane Doe / Pharmacy Admin" required value="<?= htmlspecialchars(isset($_POST['name']) ? $_POST['name'] : 'Pharmacy Administrator') ?>">
            </div>
            <div>
                <label>Email / Username (Used to login)</label>
                <input type="text" name="email" placeholder="admin@gigachemist.co.ke" required value="<?= htmlspecialchars(isset($_POST['email']) ? $_POST['email'] : '') ?>">
            </div>
            <div>
                <label>Password (Min 6 characters)</label>
                <input type="password" name="password" placeholder="••••••••" required>
            </div>
            <div>
                <label>Phone Number (Optional)</label>
                <input type="text" name="phone" placeholder="+254 700 000 000" value="<?= htmlspecialchars(isset($_POST['phone']) ? $_POST['phone'] : '') ?>">
            </div>
            <?php if ($adminExists): ?>
                <div style="margin-bottom: 16px;">
                    <label style="display: flex; align-items: center; gap: 8px; font-weight: normal; color: #cbd5e1; font-size: 12px;">
                        <input type="checkbox" name="confirm_override" value="1"> I confirm I want to add/update this administrator account.
                    </label>
                </div>
            <?php endif; ?>
            <button type="submit">Create Administrator Account</button>
        </form>

        <div class="links">
            <a href="../">&larr; Return to POS Application</a>
        </div>
    </div>
</body>
</html>
