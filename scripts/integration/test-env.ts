import 'dotenv/config';

process.env.DB_NAME = 'giga_chemist_dev';
if (process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/giga_chemist([?].*)?$/, '/giga_chemist_dev$1');
}
if (process.env.LOCAL_DATABASE_URL) {
  process.env.LOCAL_DATABASE_URL = process.env.LOCAL_DATABASE_URL.replace(/\/giga_chemist([?].*)?$/, '/giga_chemist_dev$1');
}
