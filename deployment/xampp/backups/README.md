# GIGA CHEMIST Database Backups Directory

This directory is designated for storing local backups of the `giga_chemist` database.

## Safety & Isolation Rules

1. **Do NOT touch the existing POS database backups.**
2. Keep all `giga_chemist` dumps and snapshots separate inside this folder or a dedicated backup folder such as `C:\GIGA-CHEMIST-BACKUPS\`.

## Performing a Backup

Open the XAMPP Shell or Windows Command Prompt:

```cmd
mysqldump -u root -p giga_chemist > C:\xampp\htdocs\giga-chemist\backups\giga_chemist_backup_%date:~-4,4%%date:~-7,2%%date:~-10,2%.sql
```

## Restoring from a Backup

```cmd
mysql -u root -p giga_chemist < C:\xampp\htdocs\giga-chemist\backups\your_backup_file.sql
```
