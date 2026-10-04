<?php
/**
 * GIGA CHEMIST - Local REST API Router
 * Handles all backend requests under XAMPP / Apache / MySQL
 * Compatible with PHP 5.4+ through PHP 8.3+
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

// Handle CORS Preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    jsonResponse(array('status' => 'ok'), 200);
}

$requestUri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/';
$path = parse_url($requestUri, PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'];

// Normalize path relative to /api/
// Works whether accessed via /api/... or /giga-chemist/api/...
$apiPos = strpos($path, '/api');
if ($apiPos !== false) {
    $subPath = substr($path, $apiPos + 4);
} else {
    $subPath = $path;
}
$subPath = trim($subPath, '/');
$segments = explode('/', $subPath);
$resource = isset($segments[0]) ? $segments[0] : '';
$param1 = isset($segments[1]) ? $segments[1] : null;
$param2 = isset($segments[2]) ? $segments[2] : null;

$pdo = getDb();

// -----------------------------------------------------------------------------
// 1. Health Check
// -----------------------------------------------------------------------------
if ($resource === 'health' && $method === 'GET') {
    $dbStatus = 'disconnected';
    try {
        $pdo->query('SELECT 1');
        $dbStatus = 'connected';
    } catch (Exception $e) {
        $dbStatus = 'disconnected';
    }

    jsonResponse(array(
        'status'    => 'ok',
        'mode'      => 'local_xampp',
        'database'  => $dbStatus,
        'timestamp' => date('c'),
        'server'    => isset($_SERVER['SERVER_SOFTWARE']) ? $_SERVER['SERVER_SOFTWARE'] : 'XAMPP/Apache',
        'php'       => PHP_VERSION,
    ));
}

// -----------------------------------------------------------------------------
// 2. Authentication
// -----------------------------------------------------------------------------
if ($resource === 'auth' && $param1 === 'login' && $method === 'POST') {
    handleLogin();
}

// -----------------------------------------------------------------------------
// 3. Medicines
// -----------------------------------------------------------------------------
if ($resource === 'medicines') {
    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `medicines` ORDER BY `name` ASC');
        $medicines = $stmt->fetchAll();
        foreach ($medicines as &$m) {
            $m['purchase_price'] = (float)$m['purchase_price'];
            $m['selling_price'] = (float)$m['selling_price'];
            $m['current_stock'] = (int)$m['current_stock'];
            $m['reorder_level'] = (int)$m['reorder_level'];
            $m['prescription_required'] = (bool)$m['prescription_required'];
            $m['version'] = (int)$m['version'];
        }
        jsonResponse($medicines);
    }

    if ($method === 'POST') {
        requireRole(array('ADMIN', 'MANAGER'));
        $body = getJsonBody();
        $id = giga_get($body, 'id', 'med-' . time() . '-' . rand(100, 999));
        $now = date('Y-m-d');

        $stmt = $pdo->prepare('
            INSERT INTO `medicines` (
                id, branch_id, name, generic_name, brand_name, sku, barcode,
                category, medicine_type, dosage_strength, dosage_form, manufacturer,
                description, purchase_price, selling_price, wholesale_price, min_selling_price,
                current_stock, reorder_level, unit, prescription_required, status,
                created_at, updated_at, created_by, updated_by, version
            ) VALUES (
                :id, :branch_id, :name, :generic_name, :brand_name, :sku, :barcode,
                :category, :medicine_type, :dosage_strength, :dosage_form, :manufacturer,
                :description, :purchase_price, :selling_price, :wholesale_price, :min_selling_price,
                :current_stock, :reorder_level, :unit, :prescription_required, :status,
                :created_at, :updated_at, :created_by, :updated_by, 1
            )
        ');

        $stmt->execute(array(
            ':id'                    => $id,
            ':branch_id'             => giga_get($body, 'branch_id', null),
            ':name'                  => giga_get($body, 'name', ''),
            ':generic_name'          => giga_get($body, 'generic_name', null),
            ':brand_name'            => giga_get($body, 'brand_name', null),
            ':sku'                   => giga_get($body, 'sku', null),
            ':barcode'               => giga_get($body, 'barcode', null),
            ':category'              => giga_get($body, 'category', null),
            ':medicine_type'         => giga_get($body, 'medicine_type', null),
            ':dosage_strength'       => giga_get($body, 'dosage_strength', null),
            ':dosage_form'           => giga_get($body, 'dosage_form', 'Tablet'),
            ':manufacturer'          => giga_get($body, 'manufacturer', null),
            ':description'           => giga_get($body, 'description', null),
            ':purchase_price'        => giga_get($body, 'purchase_price', 0),
            ':selling_price'         => giga_get($body, 'selling_price', 0),
            ':wholesale_price'       => giga_get($body, 'wholesale_price', null),
            ':min_selling_price'     => giga_get($body, 'min_selling_price', null),
            ':current_stock'         => giga_get($body, 'current_stock', 0),
            ':reorder_level'         => giga_get($body, 'reorder_level', 10),
            ':unit'                  => giga_get($body, 'unit', 'Unit'),
            ':prescription_required' => !empty($body['prescription_required']) ? 1 : 0,
            ':status'                => giga_get($body, 'status', 'active'),
            ':created_at'            => giga_get($body, 'created_at', $now),
            ':updated_at'            => giga_get($body, 'updated_at', $now),
            ':created_by'            => giga_get($body, 'created_by', 'User'),
            ':updated_by'            => giga_get($body, 'updated_by', 'User'),
        ));

        jsonResponse(array('success' => true, 'id' => $id));
    }

    if ($param2 === 'price' && ($method === 'PATCH' || $method === 'PUT')) {
        requireRole(array('ADMIN', 'MANAGER'));
        $body = getJsonBody();
        $stmt = $pdo->prepare('UPDATE `medicines` SET `selling_price` = :sp, `purchase_price` = :pp, `updated_at` = :now WHERE `id` = :id');
        $stmt->execute(array(
            ':sp'  => giga_get($body, 'selling_price', 0),
            ':pp'  => giga_get($body, 'purchase_price', 0),
            ':now' => date('Y-m-d'),
            ':id'  => $param1
        ));
        jsonResponse(array('success' => true));
    }
}

// -----------------------------------------------------------------------------
// 4. Batches (FEFO Ordering)
// -----------------------------------------------------------------------------
if ($resource === 'batches') {
    if ($method === 'GET') {
        if ($param1) {
            $stmt = $pdo->prepare('SELECT * FROM `medicine_batches` WHERE `medicine_id` = :mid AND `status` = "active" AND `quantity_available` > 0 ORDER BY `expiry_date` ASC');
            $stmt->execute(array(':mid' => $param1));
        } else {
            $stmt = $pdo->query('SELECT * FROM `medicine_batches` WHERE `status` = "active" AND `quantity_available` > 0 ORDER BY `expiry_date` ASC');
        }
        $batches = $stmt->fetchAll();
        foreach ($batches as &$b) {
            $b['quantity_received'] = (int)$b['quantity_received'];
            $b['quantity_available'] = (int)$b['quantity_available'];
            $b['purchase_price'] = (float)$b['purchase_price'];
        }
        jsonResponse($batches);
    }
}

// -----------------------------------------------------------------------------
// 5. Sales & Atomic Checkout
// -----------------------------------------------------------------------------
if ($resource === 'sales') {
    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `sales` ORDER BY `created_at` DESC LIMIT 500');
        $sales = $stmt->fetchAll();
        jsonResponse($sales);
    }

    // Checkout: POST /api/sales or POST /api/sales/checkout
    if ($method === 'POST' && (!$param1 || $param1 === 'checkout')) {
        $body = getJsonBody();
        $sale = giga_get($body, 'sale', $body);
        $items = giga_get($body, 'items', giga_get($sale, 'items', array()));
        $movements = giga_get($body, 'movements', array());

        $idempotencyKey = giga_get($sale, 'idempotency_key', giga_get($sale, 'id', null));

        $pdo->beginTransaction();
        try {
            // Check for existing sale with this idempotency key
            if ($idempotencyKey) {
                $check = $pdo->prepare('SELECT `id` FROM `sales` WHERE `idempotency_key` = :k OR `id` = :id LIMIT 1');
                $check->execute(array(':k' => $idempotencyKey, ':id' => giga_get($sale, 'id', '')));
                $existing = $check->fetch();
                if ($existing) {
                    $pdo->rollBack();
                    jsonResponse(array('success' => true, 'id' => $existing['id'], 'duplicate' => true));
                }
            }

            $saleId = giga_get($sale, 'id', 'sale-' . time() . '-' . rand(100, 999));
            $nowStr = date('Y-m-d H:i:s');
            $dateStr = date('Y-m-d');

            // Insert sale record
            $saleStmt = $pdo->prepare('
                INSERT INTO `sales` (
                    id, receipt_number, cashier_id, cashier_name, customer_id, customer_name,
                    subtotal, discount_amount, tax_amount, grand_total, payment_method, payment_status,
                    amount_tendered, change_given, notes, is_voided, device_id, idempotency_key,
                    date, created_at, synced
                ) VALUES (
                    :id, :receipt_number, :cashier_id, :cashier_name, :customer_id, :customer_name,
                    :subtotal, :discount_amount, :tax_amount, :grand_total, :payment_method, :payment_status,
                    :amount_tendered, :change_given, :notes, 0, :device_id, :idempotency_key,
                    :date, :created_at, 1
                )
            ');

            $saleStmt->execute(array(
                ':id'               => $saleId,
                ':receipt_number'   => giga_get($sale, 'receipt_number', 'REC-' . time()),
                ':cashier_id'       => giga_get($sale, 'cashier_id', null),
                ':cashier_name'     => giga_get($sale, 'cashier_name', 'Cashier'),
                ':customer_id'      => giga_get($sale, 'customer_id', null),
                ':customer_name'    => giga_get($sale, 'customer_name', 'Walk-in Customer'),
                ':subtotal'         => giga_get($sale, 'subtotal', 0),
                ':discount_amount'  => giga_get($sale, 'discount_amount', 0),
                ':tax_amount'       => giga_get($sale, 'tax_amount', 0),
                ':grand_total'      => giga_get($sale, 'grand_total', 0),
                ':payment_method'   => giga_get($sale, 'payment_method', 'Cash'),
                ':payment_status'   => giga_get($sale, 'payment_status', 'completed'),
                ':amount_tendered'  => giga_get($sale, 'amount_tendered', null),
                ':change_given'     => giga_get($sale, 'change_given', null),
                ':notes'            => giga_get($sale, 'notes', null),
                ':device_id'        => giga_get($sale, 'device_id', null),
                ':idempotency_key'  => $idempotencyKey,
                ':date'             => giga_get($sale, 'date', $dateStr),
                ':created_at'       => giga_get($sale, 'created_at', $nowStr),
            ));

            // Insert sale items and deduct stock
            $itemStmt = $pdo->prepare('
                INSERT INTO `sale_items` (
                    id, sale_id, medicine_id, medicine_name, batch_id, batch_number,
                    expiry_date, quantity, unit_price, cost_price, discount, total_price
                ) VALUES (
                    :id, :sale_id, :medicine_id, :medicine_name, :batch_id, :batch_number,
                    :expiry_date, :quantity, :unit_price, :cost_price, :discount, :total_price
                )
            ');

            $batchDeductStmt = $pdo->prepare('
                UPDATE `medicine_batches` 
                SET `quantity_available` = GREATEST(0, `quantity_available` - :qty)
                WHERE `id` = :bid
            ');

            $medDeductStmt = $pdo->prepare('
                UPDATE `medicines`
                SET `current_stock` = GREATEST(0, `current_stock` - :qty), `updated_at` = :now
                WHERE `id` = :mid
            ');

            foreach ($items as $item) {
                $itemId = giga_get($item, 'id', 'sitem-' . time() . '-' . rand(100, 999));
                $itemStmt->execute(array(
                    ':id'            => $itemId,
                    ':sale_id'       => $saleId,
                    ':medicine_id'   => $item['medicine_id'],
                    ':medicine_name' => giga_get($item, 'medicine_name', ''),
                    ':batch_id'      => giga_get($item, 'batch_id', null),
                    ':batch_number'  => giga_get($item, 'batch_number', null),
                    ':expiry_date'   => giga_get($item, 'expiry_date', null),
                    ':quantity'      => $item['quantity'],
                    ':unit_price'    => $item['unit_price'],
                    ':cost_price'    => giga_get($item, 'cost_price', 0),
                    ':discount'      => giga_get($item, 'discount', 0),
                    ':total_price'   => $item['total_price'],
                ));

                if (!empty($item['batch_id'])) {
                    $batchDeductStmt->execute(array(':qty' => $item['quantity'], ':bid' => $item['batch_id']));
                }
                $medDeductStmt->execute(array(':qty' => $item['quantity'], ':now' => $dateStr, ':mid' => $item['medicine_id']));
            }

            // Insert inventory movements
            if (!empty($movements)) {
                $movStmt = $pdo->prepare('
                    INSERT INTO `inventory_movements` (
                        id, medicine_id, batch_id, movement_type, quantity, previous_stock,
                        new_stock, reason, user_id, user_name, device_id, notes, date, timestamp, created_at
                    ) VALUES (
                        :id, :medicine_id, :batch_id, :movement_type, :quantity, :previous_stock,
                        :new_stock, :reason, :user_id, :user_name, :device_id, :notes, :date, :timestamp, :created_at
                    )
                ');
                foreach ($movements as $m) {
                    $movStmt->execute(array(
                        ':id'             => giga_get($m, 'id', 'mov-' . time() . '-' . rand(100, 999)),
                        ':medicine_id'    => $m['medicine_id'],
                        ':batch_id'       => giga_get($m, 'batch_id', null),
                        ':movement_type'  => giga_get($m, 'movement_type', 'OUT'),
                        ':quantity'       => $m['quantity'],
                        ':previous_stock' => giga_get($m, 'previous_stock', 0),
                        ':new_stock'      => giga_get($m, 'new_stock', 0),
                        ':reason'         => giga_get($m, 'reason', 'sale'),
                        ':user_id'        => giga_get($m, 'user_id', null),
                        ':user_name'      => giga_get($m, 'user_name', null),
                        ':device_id'      => giga_get($m, 'device_id', null),
                        ':notes'          => giga_get($m, 'notes', 'Dispensed via Sale ' . giga_get($sale, 'receipt_number', '')),
                        ':date'           => giga_get($m, 'date', $dateStr),
                        ':timestamp'      => giga_get($m, 'timestamp', time()),
                        ':created_at'     => giga_get($m, 'created_at', $nowStr),
                    ));
                }
            }

            // Update customer totals if applicable
            $customerId = giga_get($sale, 'customer_id', null);
            if (!empty($customerId)) {
                $custStmt = $pdo->prepare('
                    UPDATE `customers`
                    SET `total_purchases` = `total_purchases` + 1,
                        `total_spent` = `total_spent` + :spent,
                        `updated_at` = :now
                    WHERE `id` = :cid
                ');
                $custStmt->execute(array(
                    ':spent' => giga_get($sale, 'grand_total', 0),
                    ':now'   => $dateStr,
                    ':cid'   => $customerId
                ));
            }

            $pdo->commit();
            jsonResponse(array('success' => true, 'id' => $saleId));
        } catch (Exception $e) {
            $pdo->rollBack();
            jsonResponse(array('error' => 'Checkout transaction failed', 'details' => $e->getMessage()), 500);
        }
    }

    // Void sale: POST /api/sales/{id}/void
    if ($param2 === 'void' && $method === 'POST') {
        requireRole(array('ADMIN', 'MANAGER'));
        $body = getJsonBody();
        $saleId = $param1;

        $pdo->beginTransaction();
        try {
            $check = $pdo->prepare('SELECT * FROM `sales` WHERE `id` = :id FOR UPDATE');
            $check->execute(array(':id' => $saleId));
            $sale = $check->fetch();

            if (!$sale) {
                $pdo->rollBack();
                jsonResponse(array('error' => 'Sale not found'), 404);
            }
            if ($sale['is_voided']) {
                $pdo->rollBack();
                jsonResponse(array('error' => 'Sale is already voided'), 400);
            }

            // Mark voided
            $voidStmt = $pdo->prepare('
                UPDATE `sales`
                SET `is_voided` = 1, `void_reason` = :reason, `voided_at` = :vat, `voided_by` = :vby
                WHERE `id` = :id
            ');
            $voidStmt->execute(array(
                ':reason' => giga_get($body, 'reason', 'Voided by Manager'),
                ':vat'    => date('Y-m-d H:i:s'),
                ':vby'    => giga_get($body, 'user_name', 'Manager'),
                ':id'     => $saleId
            ));

            // Restore items
            $itemsStmt = $pdo->prepare('SELECT * FROM `sale_items` WHERE `sale_id` = :id');
            $itemsStmt->execute(array(':id' => $saleId));
            $items = $itemsStmt->fetchAll();

            $batchUpd = $pdo->prepare('UPDATE `medicine_batches` SET `quantity_available` = `quantity_available` + :qty WHERE `id` = :bid');
            $medUpd = $pdo->prepare('UPDATE `medicines` SET `current_stock` = `current_stock` + :qty WHERE `id` = :mid');

            foreach ($items as $item) {
                if ($item['batch_id']) {
                    $batchUpd->execute(array(':qty' => $item['quantity'], ':bid' => $item['batch_id']));
                }
                $medUpd->execute(array(':qty' => $item['quantity'], ':mid' => $item['medicine_id']));
            }

            $pdo->commit();
            jsonResponse(array('success' => true));
        } catch (Exception $e) {
            $pdo->rollBack();
            jsonResponse(array('error' => 'Failed to void sale', 'details' => $e->getMessage()), 500);
        }
    }
}

// -----------------------------------------------------------------------------
// 6. Customer Returns
// -----------------------------------------------------------------------------
if ($resource === 'returns' && $method === 'POST') {
    requireRole(array('ADMIN', 'MANAGER'));
    $body = getJsonBody();
    $return = giga_get($body, 'return', $body);
    $items = giga_get($body, 'items', giga_get($return, 'items', array()));

    $pdo->beginTransaction();
    try {
        $returnId = giga_get($return, 'id', 'ret-' . time() . '-' . rand(100, 999));
        $nowStr = date('Y-m-d H:i:s');
        $dateStr = date('Y-m-d');

        $retStmt = $pdo->prepare('
            INSERT INTO `customer_returns` (
                id, original_sale_id, receipt_number, customer_id, customer_name,
                total_refund_amount, refund_method, reason, cashier_id, cashier_name,
                device_id, date, created_at
            ) VALUES (
                :id, :original_sale_id, :receipt_number, :customer_id, :customer_name,
                :total_refund_amount, :refund_method, :reason, :cashier_id, :cashier_name,
                :device_id, :date, :created_at
            )
        ');

        $retStmt->execute(array(
            ':id'                  => $returnId,
            ':original_sale_id'    => $return['original_sale_id'],
            ':receipt_number'      => giga_get($return, 'receipt_number', ''),
            ':customer_id'         => giga_get($return, 'customer_id', null),
            ':customer_name'       => giga_get($return, 'customer_name', null),
            ':total_refund_amount' => giga_get($return, 'total_refund_amount', 0),
            ':refund_method'       => giga_get($return, 'refund_method', 'Cash'),
            ':reason'              => giga_get($return, 'reason', ''),
            ':cashier_id'          => giga_get($return, 'cashier_id', null),
            ':cashier_name'        => giga_get($return, 'cashier_name', 'Manager'),
            ':device_id'           => giga_get($return, 'device_id', null),
            ':date'                => giga_get($return, 'date', $dateStr),
            ':created_at'          => giga_get($return, 'created_at', $nowStr),
        ));

        $itemStmt = $pdo->prepare('
            INSERT INTO `customer_return_items` (
                id, return_id, sale_item_id, medicine_id, medicine_name, batch_id,
                batch_number, quantity, refund_unit_price, refund_subtotal, restocked, restock_reason
            ) VALUES (
                :id, :return_id, :sale_item_id, :medicine_id, :medicine_name, :batch_id,
                :batch_number, :quantity, :refund_unit_price, :refund_subtotal, :restocked, :restock_reason
            )
        ');

        $batchUpd = $pdo->prepare('UPDATE `medicine_batches` SET `quantity_available` = `quantity_available` + :qty WHERE `id` = :bid');
        $medUpd = $pdo->prepare('UPDATE `medicines` SET `current_stock` = `current_stock` + :qty WHERE `id` = :mid');

        foreach ($items as $item) {
            $itemId = giga_get($item, 'id', 'ritem-' . time() . '-' . rand(100, 999));
            $isRestocked = !empty($item['restocked']) ? 1 : 0;
            $itemStmt->execute(array(
                ':id'                => $itemId,
                ':return_id'         => $returnId,
                ':sale_item_id'      => giga_get($item, 'sale_item_id', ''),
                ':medicine_id'       => $item['medicine_id'],
                ':medicine_name'     => giga_get($item, 'medicine_name', ''),
                ':batch_id'          => giga_get($item, 'batch_id', null),
                ':batch_number'      => giga_get($item, 'batch_number', null),
                ':quantity'          => $item['quantity'],
                ':refund_unit_price' => giga_get($item, 'refund_unit_price', 0),
                ':refund_subtotal'   => giga_get($item, 'refund_subtotal', 0),
                ':restocked'         => $isRestocked,
                ':restock_reason'    => giga_get($item, 'restock_reason', 'RESTOCKED_VALID_CONDITION'),
            ));

            if ($isRestocked) {
                if (!empty($item['batch_id'])) {
                    $batchUpd->execute(array(':qty' => $item['quantity'], ':bid' => $item['batch_id']));
                }
                $medUpd->execute(array(':qty' => $item['quantity'], ':mid' => $item['medicine_id']));
            }
        }

        $pdo->commit();
        jsonResponse(array('success' => true, 'id' => $returnId));
    } catch (Exception $e) {
        $pdo->rollBack();
        jsonResponse(array('error' => 'Return transaction failed', 'details' => $e->getMessage()), 500);
    }
}

// -----------------------------------------------------------------------------
// 7. Inventory Adjustments
// -----------------------------------------------------------------------------
if ($resource === 'inventory' && $param1 === 'adjust' && $method === 'POST') {
    requireRole(array('ADMIN', 'MANAGER'));
    $body = getJsonBody();
    $medId = $body['medicine_id'];
    $batchId = giga_get($body, 'batch_id', null);
    $adjQty = (int)$body['adjustment_quantity'];
    $reason = giga_get($body, 'reason', 'stock_adjustment');
    $notes = giga_get($body, 'notes', '');

    $pdo->beginTransaction();
    try {
        if ($batchId) {
            $pdo->prepare('UPDATE `medicine_batches` SET `quantity_available` = GREATEST(0, `quantity_available` + :qty) WHERE `id` = :bid')
                ->execute(array(':qty' => $adjQty, ':bid' => $batchId));
        }
        $pdo->prepare('UPDATE `medicines` SET `current_stock` = GREATEST(0, `current_stock` + :qty), `updated_at` = :now WHERE `id` = :mid')
            ->execute(array(':qty' => $adjQty, ':now' => date('Y-m-d'), ':mid' => $medId));

        $movStmt = $pdo->prepare('
            INSERT INTO `inventory_movements` (
                id, medicine_id, batch_id, movement_type, quantity, previous_stock,
                new_stock, reason, user_id, user_name, device_id, notes, date, timestamp, created_at
            ) VALUES (
                :id, :medicine_id, :batch_id, :movement_type, :quantity, 0,
                0, :reason, :user_id, :user_name, NULL, :notes, :date, :timestamp, :created_at
            )
        ');
        $movStmt->execute(array(
            ':id'            => 'mov-adj-' . time(),
            ':medicine_id'   => $medId,
            ':batch_id'      => $batchId,
            ':movement_type' => $adjQty >= 0 ? 'IN' : 'OUT',
            ':quantity'      => abs($adjQty),
            ':reason'        => $reason,
            ':user_id'       => isset($_SERVER['HTTP_X_USER_ID']) ? $_SERVER['HTTP_X_USER_ID'] : null,
            ':user_name'     => isset($_SERVER['HTTP_X_USER_NAME']) ? $_SERVER['HTTP_X_USER_NAME'] : 'Staff',
            ':notes'         => $notes,
            ':date'          => date('Y-m-d'),
            ':timestamp'     => time(),
            ':created_at'    => date('Y-m-d H:i:s'),
        ));

        $pdo->commit();
        jsonResponse(array('success' => true));
    } catch (Exception $e) {
        $pdo->rollBack();
        jsonResponse(array('error' => 'Adjustment failed', 'details' => $e->getMessage()), 500);
    }
}

// -----------------------------------------------------------------------------
// 8. Customers
// -----------------------------------------------------------------------------
if ($resource === 'customers') {
    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `customers` ORDER BY `name` ASC');
        jsonResponse($stmt->fetchAll());
    }
    if ($method === 'POST') {
        $body = getJsonBody();
        $id = giga_get($body, 'id', 'cust-' . time());
        $stmt = $pdo->prepare('
            INSERT INTO `customers` (id, name, phone, email, address, tax_pin, status, created_at, updated_at)
            VALUES (:id, :name, :phone, :email, :address, :tax_pin, :status, :created_at, :updated_at)
            ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone), email=VALUES(email), address=VALUES(address), tax_pin=VALUES(tax_pin), updated_at=VALUES(updated_at)
        ');
        $now = date('Y-m-d');
        $stmt->execute(array(
            ':id'         => $id,
            ':name'       => giga_get($body, 'name', ''),
            ':phone'      => giga_get($body, 'phone', null),
            ':email'      => giga_get($body, 'email', null),
            ':address'    => giga_get($body, 'address', null),
            ':tax_pin'    => giga_get($body, 'tax_pin', null),
            ':status'     => giga_get($body, 'status', 'active'),
            ':created_at' => giga_get($body, 'created_at', $now),
            ':updated_at' => $now,
        ));
        jsonResponse(array('success' => true, 'id' => $id));
    }
}

// -----------------------------------------------------------------------------
// 9. Suppliers
// -----------------------------------------------------------------------------
if ($resource === 'suppliers') {
    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `suppliers` ORDER BY `name` ASC');
        jsonResponse($stmt->fetchAll());
    }
    if ($method === 'POST') {
        requireRole(array('ADMIN', 'MANAGER'));
        $body = getJsonBody();
        $id = giga_get($body, 'id', 'sup-' . time());
        $stmt = $pdo->prepare('
            INSERT INTO `suppliers` (id, name, contact_person, phone, email, address, tax_pin, balance, status, created_at, updated_at)
            VALUES (:id, :name, :contact_person, :phone, :email, :address, :tax_pin, :balance, :status, :created_at, :updated_at)
            ON DUPLICATE KEY UPDATE name=VALUES(name), contact_person=VALUES(contact_person), phone=VALUES(phone), email=VALUES(email), address=VALUES(address), tax_pin=VALUES(tax_pin), updated_at=VALUES(updated_at)
        ');
        $now = date('Y-m-d');
        $stmt->execute(array(
            ':id'             => $id,
            ':name'           => giga_get($body, 'name', ''),
            ':contact_person' => giga_get($body, 'contact_person', null),
            ':phone'          => giga_get($body, 'phone', null),
            ':email'          => giga_get($body, 'email', null),
            ':address'        => giga_get($body, 'address', null),
            ':tax_pin'        => giga_get($body, 'tax_pin', null),
            ':balance'        => giga_get($body, 'balance', 0),
            ':status'         => giga_get($body, 'status', 'active'),
            ':created_at'     => giga_get($body, 'created_at', $now),
            ':updated_at'     => $now,
        ));
        jsonResponse(array('success' => true, 'id' => $id));
    }
}

// -----------------------------------------------------------------------------
// 10. Purchases
// -----------------------------------------------------------------------------
if ($resource === 'purchases') {
    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `purchases` ORDER BY `purchase_date` DESC');
        jsonResponse($stmt->fetchAll());
    }
    if ($method === 'POST') {
        requireRole(array('ADMIN', 'MANAGER'));
        $body = getJsonBody();
        $id = giga_get($body, 'id', 'pur-' . time());
        $items = giga_get($body, 'items', array());

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare('
                INSERT INTO `purchases` (id, supplier_id, supplier_name, invoice_number, purchase_date, total_amount, payment_status, notes, created_by, created_at)
                VALUES (:id, :supplier_id, :supplier_name, :invoice_number, :purchase_date, :total_amount, :payment_status, :notes, :created_by, :created_at)
            ');
            $now = date('Y-m-d');
            $stmt->execute(array(
                ':id'             => $id,
                ':supplier_id'    => giga_get($body, 'supplier_id', null),
                ':supplier_name'  => giga_get($body, 'supplier_name', null),
                ':invoice_number' => giga_get($body, 'invoice_number', null),
                ':purchase_date'  => giga_get($body, 'purchase_date', $now),
                ':total_amount'   => giga_get($body, 'total_amount', 0),
                ':payment_status' => giga_get($body, 'payment_status', 'paid'),
                ':notes'          => giga_get($body, 'notes', null),
                ':created_by'     => giga_get($body, 'created_by', 'Staff'),
                ':created_at'     => $now,
            ));

            $itemStmt = $pdo->prepare('
                INSERT INTO `purchase_items` (id, purchase_id, medicine_id, medicine_name, batch_number, expiry_date, quantity, unit_cost, total_cost)
                VALUES (:id, :purchase_id, :medicine_id, :medicine_name, :batch_number, :expiry_date, :quantity, :unit_cost, :total_cost)
            ');

            $batchStmt = $pdo->prepare('
                INSERT INTO `medicine_batches` (
                    id, medicine_id, medicine_name, batch_number, supplier_id, supplier_name,
                    quantity_received, quantity_available, purchase_price, expiry_date,
                    received_date, purchase_invoice, created_by, created_at, status
                ) VALUES (
                    :id, :medicine_id, :medicine_name, :batch_number, :supplier_id, :supplier_name,
                    :quantity_received, :quantity_available, :purchase_price, :expiry_date,
                    :received_date, :purchase_invoice, :created_by, :created_at, "active"
                )
            ');

            $medUpd = $pdo->prepare('UPDATE `medicines` SET `current_stock` = `current_stock` + :qty, `updated_at` = :now WHERE `id` = :mid');

            foreach ($items as $item) {
                $unitCost = $item['unit_cost'];
                $totalCost = giga_get($item, 'total_cost', ($item['quantity'] * $unitCost));

                $itemStmt->execute(array(
                    ':id'            => 'pitem-' . time() . '-' . rand(100, 999),
                    ':purchase_id'   => $id,
                    ':medicine_id'   => $item['medicine_id'],
                    ':medicine_name' => giga_get($item, 'medicine_name', ''),
                    ':batch_number'  => giga_get($item, 'batch_number', ''),
                    ':expiry_date'   => giga_get($item, 'expiry_date', ''),
                    ':quantity'      => $item['quantity'],
                    ':unit_cost'     => $unitCost,
                    ':total_cost'    => $totalCost,
                ));

                $batchId = 'bat-' . time() . '-' . rand(100, 999);
                $batchStmt->execute(array(
                    ':id'                 => $batchId,
                    ':medicine_id'        => $item['medicine_id'],
                    ':medicine_name'      => giga_get($item, 'medicine_name', ''),
                    ':batch_number'       => giga_get($item, 'batch_number', ''),
                    ':supplier_id'        => giga_get($body, 'supplier_id', null),
                    ':supplier_name'      => giga_get($body, 'supplier_name', null),
                    ':quantity_received'  => $item['quantity'],
                    ':quantity_available' => $item['quantity'],
                    ':purchase_price'     => $unitCost,
                    ':expiry_date'        => giga_get($item, 'expiry_date', ''),
                    ':received_date'      => giga_get($body, 'purchase_date', $now),
                    ':purchase_invoice'   => giga_get($body, 'invoice_number', ''),
                    ':created_by'         => giga_get($body, 'created_by', 'Staff'),
                    ':created_at'         => $now,
                ));

                $medUpd->execute(array(':qty' => $item['quantity'], ':now' => $now, ':mid' => $item['medicine_id']));
            }

            $pdo->commit();
            jsonResponse(array('success' => true, 'id' => $id));
        } catch (Exception $e) {
            $pdo->rollBack();
            jsonResponse(array('error' => 'Purchase processing failed', 'details' => $e->getMessage()), 500);
        }
    }
}

// -----------------------------------------------------------------------------
// 11. Expenses
// -----------------------------------------------------------------------------
if ($resource === 'expenses') {
    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `expenses` ORDER BY `date` DESC');
        jsonResponse($stmt->fetchAll());
    }
    if ($method === 'POST') {
        $body = getJsonBody();
        $id = giga_get($body, 'id', 'exp-' . time());
        $stmt = $pdo->prepare('
            INSERT INTO `expenses` (id, category, description, amount, payment_method, reference, date, user_id, user_name, created_at)
            VALUES (:id, :category, :description, :amount, :payment_method, :reference, :date, :user_id, :user_name, :created_at)
        ');
        $stmt->execute(array(
            ':id'             => $id,
            ':category'       => giga_get($body, 'category', 'Miscellaneous'),
            ':description'    => giga_get($body, 'description', ''),
            ':amount'         => giga_get($body, 'amount', 0),
            ':payment_method' => giga_get($body, 'payment_method', 'Cash'),
            ':reference'      => giga_get($body, 'reference', null),
            ':date'           => giga_get($body, 'date', date('Y-m-d')),
            ':user_id'        => giga_get($body, 'user_id', null),
            ':user_name'      => giga_get($body, 'user_name', null),
            ':created_at'     => giga_get($body, 'created_at', date('Y-m-d H:i:s')),
        ));
        jsonResponse(array('success' => true, 'id' => $id));
    }
}

// -----------------------------------------------------------------------------
// 12. Settings
// -----------------------------------------------------------------------------
if ($resource === 'settings') {
    if ($method === 'GET') {
        $stmt = $pdo->prepare('SELECT `key_value` FROM `settings` WHERE `key_name` = "pharmacy_settings" LIMIT 1');
        $stmt->execute();
        $row = $stmt->fetch();
        if ($row) {
            jsonResponse(json_decode($row['key_value'], true));
        }
        jsonResponse(array());
    }
    if ($method === 'PUT' || $method === 'POST') {
        requireRole(array('ADMIN'));
        $body = getJsonBody();
        $stmt = $pdo->prepare('
            INSERT INTO `settings` (`key_name`, `key_value`, `updated_at`)
            VALUES ("pharmacy_settings", :val, :now)
            ON DUPLICATE KEY UPDATE `key_value` = VALUES(`key_value`), `updated_at` = VALUES(`updated_at`)
        ');
        $stmt->execute(array(
            ':val' => json_encode($body),
            ':now' => date('Y-m-d H:i:s')
        ));
        jsonResponse(array('success' => true));
    }
}

// -----------------------------------------------------------------------------
// 13. Users Management (Centralized RBAC)
// -----------------------------------------------------------------------------
if ($resource === 'users') {
    if ($method === 'GET') {
        requireRole(array('ADMIN'));
        $stmt = $pdo->query('SELECT id, branch_id, name, email, role, phone, active, created_at, last_login FROM `users` ORDER BY `name` ASC');
        $users = $stmt->fetchAll();
        foreach ($users as &$u) {
            $u['active'] = (bool)$u['active'];
        }
        jsonResponse($users);
    }

    if ($method === 'POST') {
        requireRole(array('ADMIN'));
        $body = getJsonBody();
        $id = giga_get($body, 'id', 'usr-' . time());
        $password = giga_get($body, 'password', '123456');
        $hash = hashLocalPassword($password);

        $stmt = $pdo->prepare('
            INSERT INTO `users` (id, branch_id, name, email, password_hash, role, phone, active, created_at)
            VALUES (:id, :branch_id, :name, :email, :password_hash, :role, :phone, :active, :created_at)
        ');
        $stmt->execute(array(
            ':id'            => $id,
            ':branch_id'     => giga_get($body, 'branch_id', null),
            ':name'          => giga_get($body, 'name', ''),
            ':email'         => giga_get($body, 'email', ''),
            ':password_hash' => $hash,
            ':role'          => giga_get($body, 'role', 'CASHIER'),
            ':phone'         => giga_get($body, 'phone', null),
            ':active'        => isset($body['active']) ? ($body['active'] ? 1 : 0) : 1,
            ':created_at'    => date('Y-m-d H:i:s'),
        ));
        jsonResponse(array('success' => true, 'id' => $id));
    }

    if ($param2 === 'status' && $method === 'PATCH') {
        requireRole(array('ADMIN'));
        $body = getJsonBody();
        $stmt = $pdo->prepare('UPDATE `users` SET `active` = :active WHERE `id` = :id');
        $stmt->execute(array(
            ':active' => !empty($body['active']) ? 1 : 0,
            ':id'     => $param1
        ));
        jsonResponse(array('success' => true));
    }
}

// -----------------------------------------------------------------------------
// 14. Sync Ingestion (Offline Queue Processing)
// -----------------------------------------------------------------------------
if ($resource === 'sync' && $method === 'POST') {
    $body = getJsonBody();
    $items = giga_get($body, 'items', array());
    $processed = 0;

    foreach ($items as $item) {
        $stmt = $pdo->prepare('
            INSERT INTO `sync_events` (id, entity_type, entity_id, action, payload, status, device_id, created_at, synced_at)
            VALUES (:id, :entity_type, :entity_id, :action, :payload, "synced", :device_id, :created_at, :synced_at)
            ON DUPLICATE KEY UPDATE status="synced", synced_at=VALUES(synced_at)
        ');
        $stmt->execute(array(
            ':id'          => giga_get($item, 'id', 'sync-' . time() . '-' . rand(100, 999)),
            ':entity_type' => giga_get($item, 'entity_type', 'unknown'),
            ':entity_id'   => giga_get($item, 'local_id', giga_get($item, 'id', '')),
            ':action'      => giga_get($item, 'operation', 'CREATE'),
            ':payload'     => json_encode(giga_get($item, 'payload', array())),
            ':device_id'   => giga_get($item, 'device_id', null),
            ':created_at'  => giga_get($item, 'created_at', date('Y-m-d H:i:s')),
            ':synced_at'   => date('Y-m-d H:i:s'),
        ));
        $processed++;
    }

    jsonResponse(array('success' => true, 'processed' => $processed));
}

// Fallback 404
jsonResponse(array('error' => 'Endpoint not found', 'resource' => $resource), 404);
