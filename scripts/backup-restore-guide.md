# GIGA CHEMIST — PostgreSQL Backup & Disaster Recovery Guide

## 1. Prerequisites & Environment Configuration
The backup and restore operations require access to PostgreSQL client utilities (`pg_dump`, `pg_restore`, `psql`) and the following backend environment variables:

```bash
DATABASE_URL=postgresql://postgres:[PASSWORD]@[HOST]:[PORT]/postgres
# Or discrete parameters:
PGHOST=db.your-project-ref.supabase.co
PGPORT=5432
PGDATABASE=postgres
PGUSER=postgres
PGPASSWORD=[YOUR_SECURE_PASSWORD]
```

---

## 2. Performing an Authoritative Backup (Dump)

### Full Relational Database Backup (Custom Binary Format with Compression)
```bash
# Recommended production backup command
pg_dump \
  --dbname="$DATABASE_URL" \
  --format=custom \
  --blobs \
  --verbose \
  --file="giga_chemist_backup_$(date +%Y%m%d_%H%M%S).dump"
```

### SQL Plaintext Backup (Schema & Data)
```bash
pg_dump \
  --dbname="$DATABASE_URL" \
  --format=plain \
  --clean \
  --if-exists \
  --file="giga_chemist_backup_$(date +%Y%m%d_%H%M%S).sql"
```

---

## 3. Performing Disaster Recovery (Restore)

### Restoring from Custom Format (.dump)
```bash
# 1. Terminate active connections (if restoring to existing database)
# 2. Execute pg_restore
pg_restore \
  --dbname="$DATABASE_URL" \
  --clean \
  --if-exists \
  --verbose \
  "giga_chemist_backup_YYYYMMDD_HHMMSS.dump"
```

### Restoring from SQL Plaintext (.sql)
```bash
psql \
  --dbname="$DATABASE_URL" \
  --file="giga_chemist_backup_YYYYMMDD_HHMMSS.sql"
```

---

## 4. Automated Daily Backup Automation (Cron Example)
```cron
# Run daily database backup at 02:00 AM East Africa Time (EAT)
0 2 * * * /usr/bin/pg_dump "$DATABASE_URL" -Fc -f "/var/backups/giga_chemist/backup_$(date +\%F).dump"
```
