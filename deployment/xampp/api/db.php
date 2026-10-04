<?php
/**
 * GIGA CHEMIST - Local Database Connection & Helper Utilities
 * Compatible with PHP 5.4+ through PHP 8.3+ and PDO MySQL
 */

error_reporting(E_ALL & ~E_NOTICE & ~E_WARNING);
ini_set('display_errors', '0');

/**
 * Universal array safe getter (compatible with PHP 5.4 to 8.3+)
 */
function giga_get($array, $key, $default = null) {
    if (is_array($array) && array_key_exists($key, $array) && $array[$key] !== null) {
        return $array[$key];
    }
    return $default;
}

function getConfig() {
    static $config = null;
    if ($config !== null) {
        return $config;
    }

    $configFile = __DIR__ . '/../config/config.php';
    if (file_exists($configFile)) {
        $config = require $configFile;
    } else {
        // Fallback default configuration for standard XAMPP installation
        $config = array(
            'db' => array(
                'host'     => '127.0.0.1',
                'port'     => '3306',
                'dbname'   => 'giga_chemist',
                'username' => 'root',
                'password' => '',
                'charset'  => 'utf8',
            ),
            'app' => array(
                'timezone' => 'Africa/Nairobi',
            )
        );
    }
    return $config;
}

function getDb() {
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $allConfig = getConfig();
    $dbConfig = isset($allConfig['db']) ? $allConfig['db'] : array();

    $host = isset($dbConfig['host']) ? $dbConfig['host'] : '127.0.0.1';
    $port = isset($dbConfig['port']) ? $dbConfig['port'] : '3306';
    $dbname = isset($dbConfig['dbname']) ? $dbConfig['dbname'] : 'giga_chemist';
    $charset = isset($dbConfig['charset']) ? $dbConfig['charset'] : 'utf8';
    $username = isset($dbConfig['username']) ? $dbConfig['username'] : 'root';
    $password = isset($dbConfig['password']) ? $dbConfig['password'] : '';

    $dsn = "mysql:host=" . $host . ";port=" . $port . ";dbname=" . $dbname . ";charset=" . $charset;

    $options = array(
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    );

    try {
        $pdo = new PDO($dsn, $username, $password, $options);
        return $pdo;
    } catch (PDOException $e) {
        jsonResponse(array(
            'error'   => 'Database connection error',
            'message' => 'Could not connect to local MySQL database. Ensure XAMPP MySQL service is running and config/config.php is configured.',
            'details' => $e->getMessage()
        ), 500);
    }
}

function jsonResponse($data, $statusCode = 200) {
    if (function_exists('http_response_code')) {
        http_response_code($statusCode);
    } else {
        header('HTTP/1.1 ' . $statusCode);
    }
    header('Content-Type: application/json; charset=utf-8');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, x-user-role, x-user-id, x-user-name');
    echo json_encode($data);
    exit;
}

function getJsonBody() {
    $raw = file_get_contents('php://input');
    if (empty($raw)) {
        return array();
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : array();
}

/**
 * Universal secure password hashing compatible across all PHP versions
 */
function hashLocalPassword($password) {
    if (function_exists('password_hash')) {
        return password_hash($password, PASSWORD_BCRYPT, array('cost' => 10));
    }
    // Fallback for very old PHP 5.4 environments
    $salt = substr(bin2hex(openssl_random_pseudo_bytes(16)), 0, 22);
    return crypt($password, '$2y$10$' . $salt . '$');
}

function verifyLocalPassword($password, $hash) {
    if (function_exists('password_verify')) {
        return password_verify($password, $hash);
    }
    // Fallback for very old PHP 5.4 environments
    return crypt($password, $hash) === $hash;
}
