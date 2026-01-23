<?php
/**
 * pix.php - Gera PIX QR Code via AbacatePay
 * 
 * Usa o endpoint /pixQrCode/create para gerar PIX direto com QR Code
 * 
 * Recebe: { "invoice_id": "in_xxx", "cpf": "12345678900", "customer_name": "...", "customer_email": "..." }
 * Retorna: Dados do PIX (QR Code, código copia e cola)
 */

// Headers CORS e JSON
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

// Responde OPTIONS para CORS preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// Apenas POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Método não permitido']);
    exit;
}

// Carrega variáveis de ambiente (local ou Vercel)
$envFile = __DIR__ . '/../../.env';
if (file_exists($envFile)) {
    $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        if (strpos($line, '#') === 0) continue;
        if (strpos($line, '=') !== false) {
            list($key, $value) = explode('=', $line, 2);
            putenv(trim($key) . '=' . trim($value));
        }
    }
}

// Chaves
$stripeSecret = getenv('STRIPE_SECRET');
$abacateKey = getenv('ABACATEPAY_KEY');

if (!$stripeSecret || !$abacateKey) {
    http_response_code(500);
    echo json_encode(['error' => 'Chaves de API não configuradas']);
    exit;
}

// Lê o body JSON
$input = json_decode(file_get_contents('php://input'), true);
$invoiceId = $input['invoice_id'] ?? null;
$cpf = $input['cpf'] ?? null;
$customerNameFromFront = $input['customer_name'] ?? null;
$customerEmailFromFront = $input['customer_email'] ?? null;

if (!$invoiceId) {
    http_response_code(400);
    echo json_encode(['error' => 'ID da fatura não informado']);
    exit;
}

if (!$cpf || strlen(preg_replace('/\D/', '', $cpf)) !== 11) {
    http_response_code(400);
    echo json_encode(['error' => 'CPF inválido ou não informado']);
    exit;
}

// Formata CPF (xxx.xxx.xxx-xx)
$cpfClean = preg_replace('/\D/', '', $cpf);
$cpfFormatted = substr($cpfClean, 0, 3) . '.' . 
                substr($cpfClean, 3, 3) . '.' . 
                substr($cpfClean, 6, 3) . '-' . 
                substr($cpfClean, 9, 2);

/**
 * Faz requisição para a API da Stripe
 */
function stripeRequest($endpoint, $stripeSecret, $method = 'GET', $data = null) {
    $url = 'https://api.stripe.com/v1/' . $endpoint;
    
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_USERPWD, $stripeSecret . ':');
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/x-www-form-urlencoded']);
    
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        if ($data) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($data));
        }
    }
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    
    return [
        'code' => $httpCode,
        'data' => json_decode($response, true)
    ];
}

/**
 * Faz requisição para a API do AbacatePay
 */
function abacateRequest($endpoint, $abacateKey, $data) {
    $url = 'https://api.abacatepay.com/v1/' . $endpoint;
    
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json',
        'Authorization: Bearer ' . $abacateKey
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);
    
    return [
        'code' => $httpCode,
        'data' => json_decode($response, true),
        'raw' => $response,
        'error' => $curlError
    ];
}

try {
    // 1. Busca fatura na Stripe
    $invoiceResponse = stripeRequest('invoices/' . urlencode($invoiceId), $stripeSecret);
    
    if ($invoiceResponse['code'] !== 200) {
        throw new Exception('Fatura não encontrada na Stripe');
    }
    
    $invoice = $invoiceResponse['data'];
    
    // Verifica se a fatura está aberta
    if ($invoice['status'] !== 'open') {
        throw new Exception('Esta fatura não está em aberto (status: ' . $invoice['status'] . ')');
    }
    
    $amountCents = $invoice['amount_due'];
    $customerId = $invoice['customer'];
    
    // 2. Busca dados do cliente na Stripe (ou usa os enviados pelo front)
    $customerName = $customerNameFromFront;
    $customerEmail = $customerEmailFromFront;
    $customerPhone = '11999999999';
    
    if (!$customerName || !$customerEmail) {
        $customerResponse = stripeRequest('customers/' . urlencode($customerId), $stripeSecret);
        if ($customerResponse['code'] === 200) {
            $customer = $customerResponse['data'];
            $customerName = $customerName ?: ($customer['name'] ?? 'Cliente');
            $customerEmail = $customerEmail ?: ($customer['email'] ?? 'cliente@email.com');
            $customerPhone = $customer['phone'] ?? '11999999999';
        }
    }
    
    // Garante valores padrão
    $customerName = $customerName ?: 'Cliente';
    $customerEmail = $customerEmail ?: 'cliente@email.com';
    
    // Formata telefone
    $phoneClean = preg_replace('/\D/', '', $customerPhone);
    if (strlen($phoneClean) >= 10) {
        $phoneFormatted = '(' . substr($phoneClean, 0, 2) . ') ' . 
                          substr($phoneClean, 2, 5) . '-' . 
                          substr($phoneClean, 7, 4);
    } else {
        $phoneFormatted = '(11) 99999-9999';
    }
    
    // 3. Cria PIX QR Code no AbacatePay (endpoint correto!)
    $pixData = [
        'amount' => $amountCents, // Em centavos
        'expiresIn' => 3600, // 1 hora para expirar
        'description' => 'Fatura ' . $invoiceId,
        'customer' => [
            'name' => $customerName,
            'cellphone' => $phoneFormatted,
            'email' => $customerEmail,
            'taxId' => $cpfFormatted
        ],
        'metadata' => [
            'externalId' => $invoiceId
        ]
    ];
    
    $pixResponse = abacateRequest('pixQrCode/create', $abacateKey, $pixData);
    
    if ($pixResponse['code'] !== 200 && $pixResponse['code'] !== 201) {
        $errorMsg = $pixResponse['data']['error'] ?? $pixResponse['data']['message'] ?? 'Erro desconhecido';
        if (is_array($errorMsg)) {
            $errorMsg = json_encode($errorMsg);
        }
        throw new Exception('Erro AbacatePay: ' . $errorMsg . ' (Code: ' . $pixResponse['code'] . ')');
    }
    
    // 4. Extrai dados do PIX da resposta
    $pixResult = $pixResponse['data']['data'] ?? $pixResponse['data'];
    
    // QR Code e código copia e cola
    $qrCodeImage = $pixResult['qrCode']['image'] ?? $pixResult['qrCodeImage'] ?? $pixResult['image'] ?? null;
    $pixCode = $pixResult['qrCode']['payload'] ?? $pixResult['brCode'] ?? $pixResult['payload'] ?? $pixResult['emv'] ?? null;
    $pixId = $pixResult['id'] ?? null;
    
    // Monta resposta
    $response = [
        'success' => true,
        'qr_code_url' => $qrCodeImage,
        'pix_code' => $pixCode,
        'pix_id' => $pixId,
        'amount' => $amountCents,
        'amount_formatted' => 'R$ ' . number_format($amountCents / 100, 2, ',', '.'),
        'customer' => [
            'name' => $customerName,
            'email' => $customerEmail,
            'cpf' => substr($cpfClean, 0, 3) . '.***.***-' . substr($cpfClean, -2)
        ],
        'invoice_id' => $invoiceId,
        'expires_in' => 3600,
        'raw_response' => $pixResult // Para debug
    ];
    
    echo json_encode($response);
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
