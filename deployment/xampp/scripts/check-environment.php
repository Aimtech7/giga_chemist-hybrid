<?php
/**
 * GIGA CHEMIST - Target Environment Compatibility & Diagnostic Checker
 * Can be run via CLI: php check-environment.php
 * Or via Browser: http://localhost/giga-chemist/scripts/check-environment.php
 * Compatible with PHP 5.4+ through PHP 8.3+
 */

error_reporting(E_ALL & ~E_NOTICE & ~E_WARNING);
ini_set('display_errors', '0');

$isCli = (php_sapi_name() === 'cli');

if (!$isCli) {
    echo "<!DOCTYPE html><html><head><title>GIGA CHEMIST - Environment Diagnostic</title>";
    echo "<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:30px;background:#f8fafc;color:#1e293b;}
    .card{background:#fff;padding:24px;border-radius:8px;max-width:800px;margin:0 auto;box-shadow:0 1px 3px rgba(0,0,0,0.1);}
    .pass{color:#16a34a;font-weight:bold;} .fail{color:#dc2626;font-weight:bold;} .warn{color:#d97706;font-weight:bold;}
    table{width:100%;border-collapse:collapse;margin-top:16px;} th,td{padding:10px;text-align:left;border-bottom:1px solid #e2e8f0;}
    .badge{padding:3px 8px;border-radius:4px;font-size:12px;} .badge-ok{background:#dcfce7;color:#166534;} .badge-err{background:#fee2e2;color:#991b1b;} .badge-warn{background:#fef3c7;color:#92400e;}</style></head><body><div class='card'>";
    $srv = isset($_SERVER['SERVER_SOFTWARE']) ? $_SERVER['SERVER_SOFTWARE'] : 'CLI';
    echo "<h2>🏥 GIGA CHEMIST - Environment Compatibility Checker</h2><p>Running on: " . htmlspecialchars($srv) . "</p><table>";
    echo "<tr><th>Check</th><th>Status</th><th>Details</th></tr>";
}

function printRow($label, $status, $details, $type = 'ok') {
    global $isCli;
    if ($isCli) {
        $tag = ($type === 'ok') ? '[ PASS ]' : (($type === 'warn') ? '[ WARN ]' : '[ FAIL ]');
        echo sprintf("%-35s %-10s %s\n", $label, $tag, $details);
    } else {
        $badgeClass = ($type === 'ok') ? 'badge-ok' : (($type === 'warn') ? 'badge-warn' : 'badge-err');
        echo "<tr><td>" . htmlspecialchars($label) . "</td><td><span class='badge " . $badgeClass . "'>" . strtoupper($type) . "</span></td><td>" . htmlspecialchars($details) . "</td></tr>";
    }
}

// 1. PHP Version
$phpVer = PHP_VERSION;
if (version_compare($phpVer, '7.4.0', '>=')) {
    printRow('PHP Version', 'PASS', "PHP " . $phpVer . " (Supported: 7.4 - 8.3+)", 'ok');
} elseif (version_compare($phpVer, '5.6.0', '>=')) {
    printRow('PHP Version', 'PASS', "PHP " . $phpVer . " (Supported: PHP 5.6 - 7.3+)", 'ok');
} else {
    printRow('PHP Version', 'WARN', "PHP " . $phpVer . " (Legacy PHP detected)", 'warn');
}

// 2. Required PHP Extensions
$reqExts = array(
    'pdo'        => 'PDO Data Objects',
    'pdo_mysql'  => 'PDO MySQL Driver',
    'json'       => 'JSON Serializer',
    'mbstring'   => 'Multibyte String Support',
    'openssl'    => 'OpenSSL Cryptography',
);

foreach ($reqExts as $ext => $name) {
    if (extension_loaded($ext)) {
        printRow("Extension: " . $name, 'PASS', "Loaded", 'ok');
    } else {
        printRow("Extension: " . $name, 'FAIL', "Missing extension: " . $ext, 'fail');
    }
}

// 3. Database Connection Check
$configFile = __DIR__ . '/../config/config.php';
if (!file_exists($configFile)) {
    $configFile = __DIR__ . '/../config/config.example.php';
    printRow('Config File', 'WARN', "Using config.example.php (create config.php for custom settings)", 'warn');
} else {
    printRow('Config File', 'PASS', "Found custom config/config.php", 'ok');
}

$config = file_exists($configFile) ? require($configFile) : array();
$dbConf = isset($config['db']) ? $config['db'] : array(
    'host'     => '127.0.0.1',
    'port'     => '3306',
    'dbname'   => 'giga_chemist',
    'username' => 'root',
    'password' => '',
);

try {
    $port = isset($dbConf['port']) ? $dbConf['port'] : '3306';
    $dsn = "mysql:host=" . $dbConf['host'] . ";port=" . $port . ";charset=utf8";
    $pdo = new PDO($dsn, $dbConf['username'], $dbConf['password'], array(
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_TIMEOUT => 3,
    ));
    printRow('MySQL Server Reachable', 'PASS', "Connected to " . $dbConf['host'] . ":" . $port, 'ok');

    // Check if giga_chemist database exists
    $stmt = $pdo->query("SHOW DATABASES LIKE '" . $dbConf['dbname'] . "'");
    $hasDb = $stmt->fetch();
    if ($hasDb) {
        printRow("Database '" . $dbConf['dbname'] . "'", 'PASS', "Database exists and is accessible", 'ok');
        
        // Check core tables
        $pdo->query("USE `" . $dbConf['dbname'] . "`");
        $tables = $pdo->query("SHOW TABLES")->fetchAll(PDO::FETCH_COLUMN);
        $expected = array('users', 'medicines', 'medicine_batches', 'sales', 'sale_items', 'customer_returns', 'inventory_movements', 'settings');
        $missing = array_diff($expected, $tables);
        if (empty($missing)) {
            printRow("Database Schema Tables", 'PASS', "All " . count($tables) . " tables present", 'ok');
        } else {
            printRow("Database Schema Tables", 'WARN', "Missing tables: " . implode(', ', $missing) . " (Run database/schema.sql)", 'warn');
        }
    } else {
        printRow("Database '" . $dbConf['dbname'] . "'", 'WARN', "Database not created yet. Import database/schema.sql in phpMyAdmin", 'warn');
    }
} catch (PDOException $e) {
    printRow('MySQL Connection', 'FAIL', "Connection failed: " . $e->getMessage(), 'fail');
}

// 4. File Write Permissions
$testDirs = array(
    'Backups Directory' => __DIR__ . '/../backups',
    'Config Directory'  => __DIR__ . '/../config',
);

foreach ($testDirs as $name => $path) {
    if (is_writable($path)) {
        printRow("Writable: " . $name, 'PASS', "Directory is writable", 'ok');
    } else {
        printRow("Writable: " . $name, 'WARN', "Read-only. Backups/logs may need manual write permission", 'warn');
    }
}

// 5. Browser & Scanner Compatibility Notice
printRow('Browser Compatibility', 'INFO', "Supports Chrome 80+, Firefox 78+, Edge 79+, Chromium on Windows 7", 'ok');
printRow('Barcode Scanner', 'INFO', "USB HID Keyboard Emulation supported natively", 'ok');
printRow('Thermal Printing', 'INFO', "Supports 58mm & 80mm ESC/POS and Browser Print dialog", 'ok');

if (!$isCli) {
    echo "</table><p style='margin-top:20px;font-size:12px;color:#64748b;'>GIGA CHEMIST Diagnostic Suite &bull; Note: Windows 7 Target Machine must be verified upon final deployment.</p></div></body></html>";
}
