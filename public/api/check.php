<?php
/**
 * check.php - Verifica status do PIX no AbacatePay
 * 
 * Se pago, marca a fatura como paga na Stripe automaticamente
 * 
 * Recebe: { "invoice_id": "in_xxx", "pix_id": "pix_xxx" }
 * Retorna: { "paid": true/false, "status": "...", "invoice_updated": true/false }
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
$pixId = $input['pix_id'] ?? null;

if (!$invoiceId) {
    http_response_code(400);
    echo json_encode(['error' => 'ID da fatura não informado']);
    exit;
}

if (!$pixId) {
    http_response_code(400);
    echo json_encode(['error' => 'ID do PIX não informado']);
    exit;
}

/**
 * Faz requisição GET para a API do AbacatePay
 */
function abacateGet($endpoint, $abacateKey) {
    $url = 'https://api.abacatepay.com/v1/' . $endpoint;
    
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json',
        'Authorization: Bearer ' . $abacateKey
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    
    return [
        'code' => $httpCode,
        'data' => json_decode($response, true),
        'raw' => $response
    ];
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
    // 1. Consulta o status do PIX no AbacatePay
    // Tenta primeiro pelo endpoint de status
    $pixResponse = abacateGet('pixQrCode/status/' . urlencode($pixId), $abacateKey);
    
    // Se não encontrar, tenta listar
    if ($pixResponse['code'] !== 200) {
        $listResponse = abacateGet('pixQrCode/list', $abacateKey);
        
        $found = false;
        if ($listResponse['code'] === 200 && isset($listResponse['data']['data'])) {
            foreach ($listResponse['data']['data'] as $pix) {
                if ($pix['id'] === $pixId) {
                    $pixData = $pix;
                    $found = true;
                    break;
                }
            }
        }
        
        if (!$found) {
            // Tenta check sem endpoint específico
            $checkResponse = abacateGet('pixQrCode/check/' . urlencode($pixId), $abacateKey);
            if ($checkResponse['code'] === 200) {
                $pixData = $checkResponse['data']['data'] ?? $checkResponse['data'];
                $found = true;
            }
        }
        
        if (!$found) {
            throw new Exception('PIX não encontrado no AbacatePay');
        }
    } else {
        $pixData = $pixResponse['data']['data'] ?? $pixResponse['data'];
    }
    
    // 2. Verifica o status do pagamento
    $status = $pixData['status'] ?? 'PENDING';
    $isPaid = in_array(strtoupper($status), ['PAID', 'COMPLETED', 'CONFIRMED', 'APPROVED', 'RECEIVED']);
    
    $response = [
        'paid' => $isPaid,
        'status' => $status,
        'invoice_updated' => false,
        'pix_data' => $pixData
    ];
    
    // 3. Se pago, marca a fatura na Stripe
    if ($isPaid) {
        // Primeiro verifica se a fatura ainda está aberta
        $invoiceResponse = stripeRequest('invoices/' . urlencode($invoiceId), $stripeSecret);
        
        if ($invoiceResponse['code'] === 200) {
            $invoice = $invoiceResponse['data'];
            
            if ($invoice['status'] === 'open') {
                // Marca como paga
                $payResponse = stripeRequest(
                    'invoices/' . urlencode($invoiceId) . '/pay',
                    $stripeSecret,
                    'POST',
                    ['paid_out_of_band' => 'true']
                );
                
                if ($payResponse['code'] === 200) {
                    $response['invoice_updated'] = true;
                    $response['stripe_status'] = 'paid';
                } else {
                    $response['stripe_error'] = $payResponse['data']['error']['message'] ?? 'Erro ao atualizar fatura';
                }
            } else if ($invoice['status'] === 'paid') {
                // Já estava paga
                $response['invoice_updated'] = true;
                $response['stripe_status'] = 'already_paid';
            }
        }
    }
    
    echo json_encode($response);
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
