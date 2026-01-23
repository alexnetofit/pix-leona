<?php
/**
 * pay.php - Marca fatura como paga na Stripe (paid_out_of_band)
 * 
 * Recebe: { "invoice_id": "in_xxx" }
 * Retorna: Dados da fatura atualizada
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

// Chave da Stripe (funciona local e na Vercel)
$stripeSecret = getenv('STRIPE_SECRET');

if (!$stripeSecret) {
    http_response_code(500);
    echo json_encode(['error' => 'Chave Stripe não configurada']);
    exit;
}

// Lê o body JSON
$input = json_decode(file_get_contents('php://input'), true);
$invoiceId = $input['invoice_id'] ?? null;

if (!$invoiceId) {
    http_response_code(400);
    echo json_encode(['error' => 'ID da fatura não informado']);
    exit;
}

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

try {
    // 1. Verifica se a fatura existe e está aberta
    $invoiceResponse = stripeRequest('invoices/' . urlencode($invoiceId), $stripeSecret);
    
    if ($invoiceResponse['code'] !== 200) {
        throw new Exception('Fatura não encontrada');
    }
    
    $invoice = $invoiceResponse['data'];
    
    if ($invoice['status'] !== 'open') {
        throw new Exception('Esta fatura não está em aberto (status: ' . $invoice['status'] . ')');
    }
    
    // 2. Marca a fatura como paga (paid_out_of_band)
    $payResponse = stripeRequest(
        'invoices/' . urlencode($invoiceId) . '/pay',
        $stripeSecret,
        'POST',
        ['paid_out_of_band' => 'true']
    );
    
    if ($payResponse['code'] !== 200) {
        $errorMsg = $payResponse['data']['error']['message'] ?? 'Erro ao marcar fatura como paga';
        throw new Exception($errorMsg);
    }
    
    // Retorna sucesso
    echo json_encode([
        'success' => true,
        'invoice' => [
            'id' => $payResponse['data']['id'],
            'status' => $payResponse['data']['status'],
            'amount_paid' => $payResponse['data']['amount_paid']
        ],
        'message' => 'Fatura marcada como paga com sucesso'
    ]);
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
