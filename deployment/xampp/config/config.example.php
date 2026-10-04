<?php
/**
 * GIGA CHEMIST - Local XAMPP Configuration Template
 * 
 * Copy this file to: deployment/xampp/config/config.php (or C:\xampp\htdocs\giga-chemist\config\config.php)
 * and update the database credentials below.
 */

return [
    'db' => [
        'host'     => '127.0.0.1',
        'port'     => '3306',
        'dbname'   => 'giga_chemist',
        'username' => 'root',
        'password' => '', // Set your MySQL password if configured in XAMPP
        'charset'  => 'utf8mb4',
    ],
    'app' => [
        'name'        => 'GIGA CHEMIST',
        'environment' => 'production',
        'debug'       => false,
        'timezone'    => 'Africa/Nairobi',
        'session_lifetime_hours' => 24,
    ],
    'security' => [
        // Generated salt/secret key for local sessions
        'app_key'     => 'change-this-to-a-secure-random-string-during-setup',
    ]
];
