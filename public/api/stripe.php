<?php
/**
 * stripe.php - Busca cliente e faturas em aberto na Stripe
 * 
 * Recebe: { "email": "cliente@exemplo.com" }
 * Retorna: { "customer": {...}, "invoices": [...] }
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
$email = $input['email'] ?? null;

if (!$email || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    http_response_code(400);
    echo json_encode(['error' => 'E-mail inválido']);
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
    
    if ($method === 'POST' && $data) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($data));
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
    // 1. Busca cliente pelo e-mail
    $customersResponse = stripeRequest(
        'customers?email=' . urlencode($email) . '&limit=1',
        $stripeSecret
    );
    
    if ($customersResponse['code'] !== 200) {
        throw new Exception('Erro ao buscar cliente na Stripe');
    }
    
    $customers = $customersResponse['data']['data'] ?? [];
    
    if (empty($customers)) {
        http_response_code(404);
        echo json_encode(['error' => 'Cliente não encontrado na Stripe']);
        exit;
    }
    
    $customer = $customers[0];
    $customerId = $customer['id'];
    
    // 2. Busca faturas em aberto do cliente
    $invoicesResponse = stripeRequest(
        'invoices?customer=' . urlencode($customerId) . '&status=open&limit=100',
        $stripeSecret
    );
    
    if ($invoicesResponse['code'] !== 200) {
        throw new Exception('Erro ao buscar faturas na Stripe');
    }
    
    $invoicesData = $invoicesResponse['data']['data'] ?? [];
    
    // 3. Formata resposta
    $invoices = [];
    foreach ($invoicesData as $invoice) {
        $invoices[] = [
            'invoice_id' => $invoice['id'],
            'amount_due' => $invoice['amount_due'],
            'customer_id' => $invoice['customer'],
            'description' => $invoice['description'] ?? 'Fatura Stripe',
            'created' => $invoice['created']
        ];
    }
    
    // Retorna dados
    echo json_encode([
        'customer' => [
            'id' => $customer['id'],
            'email' => $customer['email'],
            'name' => $customer['name'] ?? null
        ],
        'invoices' => $invoices
    ]);
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
