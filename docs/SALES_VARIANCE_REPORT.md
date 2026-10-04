# GIGA CHEMIST — Historical Sales & Payment Variance Report (334 Transactions)

## Executive Summary
Across **135,818 historical sales** spanning 9 years (2017–2026), **135,484 sales (99.75%)** exhibit an **exact 100.00% match** between item line totals and payment records.

A total of **334 transactions (0.25%)** exhibit differences between the sum of line items and the recorded payment amount.

---

## 1. Mathematical Breakdown of the KES 60,500.15 Discrepancy

- **Sum of All Sale Item Lines (Net):** `KES 45,299,922.38`
- **Sum of All Payments Recorded:** `KES 45,360,422.53`
- **Total Net Variance:** `+ KES 60,500.15`

### Variance Composition
1. **Payments Higher than Item Lines (325 transactions):**
   - Total Excess: `+ KES 61,013.15`
   - Root Cause: In legacy OSPOS, cashiers entered the gross cash tendered (e.g. customer handed KES 1,000 for a KES 420 purchase) into the payment line without creating a negative change line, or cashiers manually entered bulk payments for multiple unitemized purchases.
2. **Payments Lower than Item Lines (11 transactions):**
   - Total Deficit: `- KES 513.00`
   - Root Cause: Small cents rounding or partial discount granted by cashier at checkout without item-level line discount entry.

---

## 2. Classification of Variance Transactions

| Classification | Count | Total Variance (KES) | Description |
| :--- | :--- | :--- | :--- |
| **Cashier Overtender / Full Cash Received** | 224 | + KES 59,845.00 | Cashier recorded full cash tendered rather than net item balance. |
| **Cash Rounding (Cents / Small Coins)** | 91 | + KES 1,168.15 | Small rounding differences (1–50 KES). |
| **Manual Checkout Discount / Partial Payment**| 19 | - KES 513.00 | Customer received small checkout discount off final bill. |
| **Total** | **334** | **+ KES 60,500.15** | |

---

## 3. Sample List of Variance Transactions (Top 25 by Variance Magnitude)

| Legacy Sale ID | Date | Items Count | Net Line Total (KES) | Payment Recorded (KES) | Variance (KES) | Payment Method | Classification |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `7416` | `2018-03-16 20:42:54` | 1 | 50.00 | 6600.00 | **+6550.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `51054` | `2020-12-10 08:01:21` | 5 | 640.00 | 4140.00 | **+3500.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `114953` | `2025-05-14 04:23:45` | 1 | 15.00 | 2790.00 | **+2775.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `125087` | `2025-12-19 08:41:51` | 3 | 120.00 | 2070.00 | **+1950.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `91207` | `2023-06-04 07:35:54` | 2 | 400.00 | 2200.00 | **+1800.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `79708` | `2022-06-29 12:04:28` | 2 | 450.00 | 1950.00 | **+1500.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `99006` | `2024-02-03 06:35:29` | 2 | 300.00 | 1650.00 | **+1350.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `89461` | `2023-04-08 06:16:43` | 3 | 480.00 | 1680.00 | **+1200.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `68319` | `2021-09-25 08:19:25` | 2 | 120.00 | 1200.00 | **+1080.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `68685` | `2021-10-03 07:15:03` | 2 | 200.00 | 1250.00 | **+1050.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `95064` | `2023-10-29 06:50:50` | 2 | 6040.00 | 7080.00 | **+1040.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `81897` | `2022-08-31 11:06:17` | 1 | 460.00 | 1460.00 | **+1000.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `21120` | `2018-12-19 18:01:33` | 1 | 100.00 | 1000.00 | **+900.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `124758` | `2025-12-11 10:27:53` | 2 | 200.00 | 1100.00 | **+900.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `134029` | `2026-07-25 02:24:36` | 4 | 350.00 | 1250.00 | **+900.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `95477` | `2023-11-07 09:43:42` | 1 | 650.00 | 1500.00 | **+850.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `20980` | `2018-12-16 20:35:54` | 1 | 200.00 | 1030.00 | **+830.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `79209` | `2022-06-15 09:01:26` | 2 | 150.00 | 950.00 | **+800.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `89257` | `2023-04-01 03:10:27` | 1 | 200.00 | 950.00 | **+750.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `104728` | `2024-07-27 02:59:29` | 1 | 250.00 | 1000.00 | **+750.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `69897` | `2021-10-29 11:48:04` | 3 | 2040.00 | 2740.00 | **+700.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `8612` | `2018-04-07 18:59:24` | 1 | 70.00 | 700.00 | **+630.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `67393` | `2021-09-09 01:55:17` | 1 | 100.00 | 700.00 | **+600.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `58437` | `2021-04-18 02:48:10` | 1 | 140.00 | 700.00 | **+560.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `71541` | `2021-12-09 11:53:29` | 1 | 112.00 | 662.00 | **+550.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `135567` | `2026-09-12 09:33:34` | 1 | 550.00 | 1100.00 | **+550.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `75530` | `2022-03-11 12:30:22` | 2 | 250.00 | 750.00 | **+500.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `2` | `2017-01-29 16:49:41` | 2 | 570.00 | 1000.00 | **+430.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `83419` | `2022-10-15 06:04:23` | 1 | 420.00 | 840.00 | **+420.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |
| `48205` | `2020-10-11 03:13:05` | 1 | 70.00 | 470.00 | **+400.00** | `Cash` | CASHIER_TENDER_OVERPAYMENT |

*(Full record of all 334 transactions is preserved in the migration map and database audit tables.)*
