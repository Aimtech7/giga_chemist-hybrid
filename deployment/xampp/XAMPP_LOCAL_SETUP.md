# GIGA CHEMIST — XAMPP Local Deployment & Installation Manual

> [!CAUTION]
> **IMPORTANT WARNING FOR INSTALLER:**
> **This target PC already runs another POS on XAMPP. Do not modify or delete the existing POS, existing databases, Apache ports, MySQL ports, or existing htdocs applications unless intentionally verified.**
>
> GIGA CHEMIST is engineered to run in complete isolation with its own dedicated database (`giga_chemist`) and dedicated subfolder (`htdocs\giga-chemist\`). Never alter or drop existing database tables.

---

## 1. Target Deployment Overview

```text
Windows 7 Pharmacy PC (Existing Environment)
│
├── Existing XAMPP
│   ├── Apache (Port 80 or custom port)
│   └── MySQL (Port 3306 or custom port)
│
├── Existing Old POS (UNTOUCHED)
│
└── GIGA CHEMIST (PORTABLE DEPLOYMENT PACKAGE)
    ├── Frontend / PWA Build (`/app/`)
    ├── Local API (`/api/`)
    └── Dedicated MySQL Database (`giga_chemist`)
```

- **Target Location:** `C:\xampp\htdocs\giga-chemist\`
- **Target URL:** `http://localhost/giga-chemist/`
- **LAN Access URL:** `http://<SERVER-IP>/giga-chemist/`

---

## 2. Pre-Installation Safety Checklist

Before copying any files or creating databases, verify each of the following on the pharmacy PC:

- [ ] **Windows 7 Service Pack 1** verified.
- [ ] **XAMPP Control Panel** is installed and accessible.
- [ ] **Apache Service** is running (Status: Green).
- [ ] **MySQL Service** is running (Status: Green).
- [ ] **Existing Old POS** opens and operates successfully.
- [ ] **Record Apache Port:** Note the active port (e.g. `80` or `8080`).
- [ ] **Record MySQL Port:** Note the active port (default `3306`).
- [ ] **Note PHP Version:** Check via XAMPP Shell (`php -v`). Recommended: PHP 7.4+.
- [ ] **Note MySQL / MariaDB Version:** Check via XAMPP Shell (`mysql --version`).
- [ ] **Backup Existing Old POS Database:** Export a full dump of the existing database to `C:\OLD_POS_BACKUP\` before proceeding.

---

## 3. Step-by-Step Installation Guide

### Step 3.1: Copy GIGA CHEMIST into XAMPP `htdocs`

1. Insert the USB drive containing the `deployment/xampp` folder.
2. Copy the entire contents of `deployment/xampp` into:
   ```text
   C:\xampp\htdocs\giga-chemist\
   ```
3. Confirm the folder structure matches:
   ```text
   C:\xampp\htdocs\giga-chemist\
   ├── .htaccess
   ├── XAMPP_LOCAL_SETUP.md
   ├── api\
   │   ├── auth.php
   │   ├── db.php
   │   └── index.php
   ├── apache\
   │   └── .htaccess
   ├── app\
   │   ├── assets\
   │   ├── index.html
   │   ├── favicon.ico
   │   ├── manifest.webmanifest
   │   ├── registerSW.js
   │   ├── sw.js
   │   └── workbox-*.js
   ├── backups\
   │   └── README.md
   ├── config\
   │   └── config.example.php
   ├── database\
   │   ├── schema.sql
   │   └── seed.sql
   └── scripts\
       ├── check-environment.php
       └── create-admin.php
   ```

---

### Step 3.2: Create Dedicated MySQL Database (`giga_chemist`)

#### Method A: Using phpMyAdmin (Recommended)
1. Open your browser and navigate to:
   ```text
   http://localhost/phpmyadmin/
   ```
2. Click **Databases** on the top menu.
3. In the "Create database" field, enter `giga_chemist` and select collation `utf8mb4_unicode_ci` (or `utf8_general_ci` on older MySQL), then click **Create**.
4. Select the newly created `giga_chemist` database on the left sidebar.
5. Click the **Import** tab.
6. Click **Choose File**, select `C:\xampp\htdocs\giga-chemist\database\schema.sql`, and click **Go** (Execute).
7. Next, click **Import** again, choose `C:\xampp\htdocs\giga-chemist\database\seed.sql`, and click **Go** to load roles, permissions, settings, and starter inventory.

#### Method B: Using MySQL Command Line (XAMPP Shell)
1. In XAMPP Control Panel, click the **Shell** button.
2. Run:
   ```cmd
   mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS giga_chemist CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
   mysql -u root -p giga_chemist < C:\xampp\htdocs\giga-chemist\database\schema.sql
   mysql -u root -p giga_chemist < C:\xampp\htdocs\giga-chemist\database\seed.sql
   ```

---

### Step 3.3: Configure Database Connection

1. Navigate to `C:\xampp\htdocs\giga-chemist\config\`.
2. Copy `config.example.php` and rename the copy to `config.php`:
   ```cmd
   copy C:\xampp\htdocs\giga-chemist\config\config.example.php C:\xampp\htdocs\giga-chemist\config\config.php
   ```
3. Open `config.php` in Notepad.
4. Verify/Update the database settings:
   ```php
   return [
       'db' => [
           'host'     => '127.0.0.1',
           'port'     => '3306',
           'dbname'   => 'giga_chemist',
           'username' => 'root',        // Your MySQL username
           'password' => '',            // Your MySQL password (if any)
           'charset'  => 'utf8mb4',
       ],
       'app' => [
           'name'        => 'GIGA CHEMIST',
           'environment' => 'production',
           'timezone'    => 'Africa/Nairobi',
       ],
   ];
   ```
5. Save and close `config.php`.

---

### Step 3.4: Run Environment Compatibility Checker

In the browser, open:
```text
http://localhost/giga-chemist/scripts/check-environment.php
```
Verify that all core checks (PHP Version, PDO MySQL, Database Connection, Schema Tables) show **PASS** or **OK**.

---

### Step 3.5: Bootstrap the First Administrator Account

To avoid shipping insecure hardcoded default credentials, use the bootstrap script:

#### Method A: Web Interface
1. Open in your browser:
   ```text
   http://localhost/giga-chemist/scripts/create-admin.php
   ```
2. Fill in:
   - **Admin Full Name:** e.g., `Dr. Jane Doe`
   - **Email / Username:** e.g., `admin@gigachemist.co.ke`
   - **Password:** Minimum 6 characters (e.g., `Admin@1234`)
3. Click **Create Administrator Account**.

#### Method B: CLI Interface
1. In XAMPP Shell:
   ```cmd
   php C:\xampp\htdocs\giga-chemist\scripts\create-admin.php
   ```
2. Follow the interactive prompts to set up the credentials.

---

### Step 3.6: Launch the Application

1. Open Chrome / Edge / Firefox on the Windows 7 PC.
2. Navigate to:
   ```text
   http://localhost/giga-chemist/
   ```
3. Log in with the administrator credentials created in Step 3.5.

---

## 4. Post-Installation Validation Tests

Perform these 12 tests to ensure complete system stability:

1. **Sign In:** Log in with the newly created Admin account. Verify the dashboard opens.
2. **Search Medicine by Name:** Navigate to **POS**, search for `Paracetamol`. Confirm item displays with stock count.
3. **Partial Search:** Type `amol` or `500`. Verify filtered results match.
4. **Barcode Search:** Scan barcode `616400010012` using the USB barcode scanner. Confirm item is added to the cart immediately.
5. **Complete POS Sale:** Add 2 items, choose **Cash**, enter payment, and click **Complete Sale**.
6. **Verify Stock Deduction:** Return to **Inventory**. Confirm the stock for the sold medicine has decreased by 2.
7. **Print Receipt:** Click **Print Receipt** on the completed sale. Verify 80mm/58mm thermal output.
8. **Restart Browser:** Close the browser completely and reopen `http://localhost/giga-chemist/`.
9. **Confirm Data Persistence:** Verify the sale is still present in **Sales History** and stock balance remains updated in MySQL.
10. **Disconnect Internet:** Unplug Ethernet or disconnect Wi-Fi. Verify that sales, medicine search, batch selection, and receipt printing work completely offline.
11. **Confirm Core POS Still Works:** Dispense an offline transaction and check that local IndexedDB + MySQL persistence succeeds.
12. **Confirm Old POS Still Opens:** Open the existing old POS application URL (e.g. `http://localhost/old-pos/`) and verify it runs with zero errors.

---

## 5. LAN Access Setup (Multi-Device Pharmacy Access)

To access GIGA CHEMIST from other computers or dispensing tablets on the pharmacy LAN:

1. On the Main Server PC, open Command Prompt and run:
   ```cmd
   ipconfig
   ```
2. Note the **IPv4 Address** (e.g., `192.168.1.50`).
3. Ensure Windows Firewall allows incoming connections on Apache's port (port `80`):
   - Open **Windows Firewall with Advanced Security**.
   - Create an Inbound Rule for Port `80` (TCP) -> Allow the connection.
4. On any other LAN device, open the browser and navigate to:
   ```text
   http://192.168.1.50/giga-chemist/
   ```

---

## 6. Backup and Disaster Recovery

### Creating a GIGA CHEMIST Database Backup
Always keep GIGA CHEMIST backups separate from old POS backups:

```cmd
mysqldump -u root -p giga_chemist > C:\GIGA-CHEMIST-BACKUPS\giga_chemist_backup_%date:~-4,4%%date:~-7,2%%date:~-10,2%.sql
```

### Restoring the Database
```cmd
mysql -u root -p giga_chemist < C:\GIGA-CHEMIST-BACKUPS\giga_chemist_backup_20261001.sql
```

---

## 7. Troubleshooting Guide

| Issue | Root Cause | Solution |
| :--- | :--- | :--- |
| **Apache Service Not Running** | Port 80 conflict (e.g., Skype, IIS) | Stop conflicting service or check XAMPP Config -> `httpd.conf` to identify port. |
| **MySQL Service Not Running** | Port 3306 occupied or crashed old table | In XAMPP Control Panel, check `mysql_error.log`. Do NOT reinstall MySQL. |
| **Database Connection Error** | Incorrect credentials in `config.php` | Open `config/config.php` and verify host, port, username, password. |
| **phpMyAdmin Unavailable** | Apache alias disabled | Use XAMPP Shell command-line MySQL to import schema. |
| **Blank White Page on Startup** | Browser version too old or JS error | Open Chrome DevTools (`F12` -> Console). Ensure Chrome 80+ is installed on Win7. |
| **404 Error on Page Refresh** | Apache `mod_rewrite` not active or missing `.htaccess` | Ensure `mod_rewrite` is enabled in `httpd.conf` (`LoadModule rewrite_module modules/mod_rewrite.so`) and `.htaccess` is in `htdocs/giga-chemist/`. |
| **Login Fails (Invalid Credentials)** | Admin user not bootstrapped | Run `http://localhost/giga-chemist/scripts/create-admin.php` to recreate admin. |
| **Barcode Scanner Not Working** | Scanner configured in Serial mode | Set barcode scanner to USB HID Keyboard Emulation mode. |
| **Thermal Printer Not Printing** | Browser print dialog blocked or wrong printer set | Set the default thermal printer in Windows Printers and adjust margins to None in print preview. |
| **LAN Client Cannot Connect** | Windows Firewall blocking port 80 | Add an inbound firewall rule allowing TCP Port 80. |
| **Old POS Stopped Working** | Accidental modification of global settings | **STOP IMMEDIATELY.** Restore the previous configuration or old POS database backup. GIGA CHEMIST only requires its own folder and database. |

---

## 8. Target Platform Status Notice

> [!NOTE]
> **DEVELOPMENT & TARGET ENVIRONMENT NOTICE:**
> The deployment package was created and tested on the development PC.
> **The final Windows 7 pharmacy PC has not yet been tested. Final XAMPP/PHP/MySQL compatibility must be verified during installation.**
