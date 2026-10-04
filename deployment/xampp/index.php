<?php
/**
 * GIGA CHEMIST - Universal Root Front Controller for XAMPP
 * 
 * Functions as both:
 * 1. Fallback router when mod_rewrite is disabled/restricted.
 * 2. Apache DirectoryIndex handler when accessing http://localhost/giga-chemist/
 */

error_reporting(E_ALL & ~E_NOTICE & ~E_WARNING);
ini_set('display_errors', '0');

$requestUri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/';
$path = parse_url($requestUri, PHP_URL_PATH);

// 1. Delegate /api/* requests to api/index.php
if (strpos($path, '/api') !== false || substr($path, -4) === '/api') {
    require_once __DIR__ . '/api/index.php';
    exit;
}

// 2. Delegate /scripts/* requests
if (preg_match('#/scripts/([a-zA-Z0-9_-]+\.php)#', $path, $matches)) {
    $scriptFile = __DIR__ . '/scripts/' . $matches[1];
    if (file_exists($scriptFile)) {
        require_once $scriptFile;
        exit;
    }
}

// 3. Serve physical static assets from app/ if requested
$appDir = __DIR__ . '/app';
$relativeAsset = preg_replace('#^.*?/giga-chemist/#', '', $path);
$relativeAsset = ltrim($relativeAsset, '/');

if (!empty($relativeAsset)) {
    $targetFile = $appDir . '/' . $relativeAsset;
    if (file_exists($targetFile) && is_file($targetFile)) {
        $ext = strtolower(pathinfo($targetFile, PATHINFO_EXTENSION));
        $mimes = array(
            'js'         => 'application/javascript',
            'css'        => 'text/css',
            'html'       => 'text/html',
            'json'       => 'application/json',
            'webmanifest'=> 'application/manifest+json',
            'png'        => 'image/png',
            'jpg'        => 'image/jpeg',
            'jpeg'       => 'image/jpeg',
            'gif'        => 'image/gif',
            'svg'        => 'image/svg+xml',
            'ico'        => 'image/x-icon',
            'woff'       => 'font/woff',
            'woff2'      => 'font/woff2',
            'ttf'        => 'font/ttf',
        );
        $mime = isset($mimes[$ext]) ? $mimes[$ext] : 'application/octet-stream';
        header('Content-Type: ' . $mime);
        header('Content-Length: ' . filesize($targetFile));
        readfile($targetFile);
        exit;
    }
}

// 4. Default / SPA fallback: serve app/index.html
$indexHtml = $appDir . '/index.html';
if (file_exists($indexHtml)) {
    header('Content-Type: text/html; charset=utf-8');
    readfile($indexHtml);
    exit;
}

// If app/index.html is somehow missing, show a clean informative error
header('Content-Type: text/html; charset=utf-8');
echo '<!DOCTYPE html><html><head><title>GIGA CHEMIST Setup</title><style>body{font-family:sans-serif;padding:40px;background:#0f172a;color:#f8fafc;}</style></head><body>';
echo '<h1>🏥 GIGA CHEMIST</h1>';
echo '<p>Frontend bundle (app/index.html) not found. Please ensure the full deployment package is copied to <code>C:\\xampp\\htdocs\\giga-chemist\\</code>.</p>';
echo '<p><a href="scripts/check-environment.php" style="color:#38bdf8;">Run Environment Diagnostics &rarr;</a></p>';
echo '</body></html>';
exit;
