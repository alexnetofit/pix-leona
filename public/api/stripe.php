<?php
/**
 * stripe.php - Busca cliente e TODAS as faturas na Stripe
 * 
 * Recebe: { "email": "cliente@exemplo.com" }
 * Retorna: { "customer": {...}, "subscriptions": [...] }
 * 
 * As faturas são agrupadas por assinatura
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

// Normaliza email para minúsculas
$email = strtolower(trim($email));

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

/**
 * Traduz status da fatura para português
 */
function translateStatus($status) {
    $translations = [
        'draft' => 'Rascunho',
        'open' => 'Em Aberto',
        'paid' => 'Paga',
        'uncollectible' => 'Não Cobrável',
        'void' => 'Cancelada'
    ];
    return $translations[$status] ?? $status;
}

/**
 * Retorna cor do status para o frontend
 */
function getStatusColor($status) {
    $colors = [
        'draft' => '#6c757d',
        'open' => '#ffc107',
        'paid' => '#00d4aa',
        'uncollectible' => '#dc3545',
        'void' => '#6c757d'
    ];
    return $colors[$status] ?? '#6c757d';
}

try {
    // 1. Busca cliente pelo e-mail (case insensitive - Stripe já faz isso)
    $customersResponse = stripeRequest(
        'customers?email=' . urlencode($email) . '&limit=100',
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
    
    // Pode ter múltiplos clientes com emails similares
    $customer = $customers[0];
    $customerId = $customer['id'];
    
    // 2. Busca TODAS as faturas do cliente (sem filtro de status)
    $invoicesResponse = stripeRequest(
        'invoices?customer=' . urlencode($customerId) . '&limit=100',
        $stripeSecret
    );
    
    if ($invoicesResponse['code'] !== 200) {
        throw new Exception('Erro ao buscar faturas na Stripe');
    }
    
    $invoicesData = $invoicesResponse['data']['data'] ?? [];
    
    // 3. Busca assinaturas do cliente
    $subscriptionsResponse = stripeRequest(
        'subscriptions?customer=' . urlencode($customerId) . '&limit=100&status=all',
        $stripeSecret
    );
    
    $subscriptionsData = [];
    if ($subscriptionsResponse['code'] === 200) {
        $subscriptionsData = $subscriptionsResponse['data']['data'] ?? [];
    }
    
    // Mapa de assinaturas para fácil acesso
    $subscriptionsMap = [];
    foreach ($subscriptionsData as $sub) {
        // Pega o nome do produto da assinatura
        $productName = 'Assinatura';
        if (!empty($sub['items']['data'])) {
            $item = $sub['items']['data'][0];
            $productName = $item['price']['nickname'] ?? $item['plan']['nickname'] ?? 'Assinatura';
            
            // Tenta pegar o nome do produto
            if (isset($item['price']['product'])) {
                $productId = $item['price']['product'];
                $productResponse = stripeRequest('products/' . $productId, $stripeSecret);
                if ($productResponse['code'] === 200) {
                    $productName = $productResponse['data']['name'] ?? $productName;
                }
            }
        }
        
        $subscriptionsMap[$sub['id']] = [
            'id' => $sub['id'],
            'status' => $sub['status'],
            'product_name' => $productName,
            'current_period_end' => $sub['current_period_end'],
            'invoices' => []
        ];
    }
    
    // 4. Agrupa faturas por assinatura
    $invoicesWithoutSubscription = [];
    
    foreach ($invoicesData as $invoice) {
        $invoiceFormatted = [
            'invoice_id' => $invoice['id'],
            'amount_due' => $invoice['amount_due'],
            'amount_paid' => $invoice['amount_paid'] ?? 0,
            'status' => $invoice['status'],
            'status_label' => translateStatus($invoice['status']),
            'status_color' => getStatusColor($invoice['status']),
            'customer_id' => $invoice['customer'],
            'subscription_id' => $invoice['subscription'] ?? null,
            'description' => $invoice['description'] ?? 'Fatura Stripe',
            'created' => $invoice['created'],
            'due_date' => $invoice['due_date'] ?? null,
            'invoice_url' => $invoice['hosted_invoice_url'] ?? null,
            'can_generate_pix' => ($invoice['status'] === 'open')
        ];
        
        $subscriptionId = $invoice['subscription'] ?? null;
        
        if ($subscriptionId && isset($subscriptionsMap[$subscriptionId])) {
            $subscriptionsMap[$subscriptionId]['invoices'][] = $invoiceFormatted;
        } else {
            $invoicesWithoutSubscription[] = $invoiceFormatted;
        }
    }
    
    // 5. Monta resposta final
    $subscriptions = array_values($subscriptionsMap);
    
    // Adiciona grupo de faturas avulsas (sem assinatura) se houver
    if (!empty($invoicesWithoutSubscription)) {
        $subscriptions[] = [
            'id' => 'no_subscription',
            'status' => 'active',
            'product_name' => 'Faturas Avulsas',
            'current_period_end' => null,
            'invoices' => $invoicesWithoutSubscription
        ];
    }
    
    // Ordena faturas dentro de cada assinatura (mais recentes primeiro)
    foreach ($subscriptions as &$sub) {
        usort($sub['invoices'], function($a, $b) {
            return $b['created'] - $a['created'];
        });
    }
    
    // Conta totais
    $totalInvoices = count($invoicesData);
    $openInvoices = count(array_filter($invoicesData, fn($i) => $i['status'] === 'open'));
    
    // Retorna dados
    echo json_encode([
        'customer' => [
            'id' => $customer['id'],
            'email' => $customer['email'],
            'name' => $customer['name'] ?? null
        ],
        'subscriptions' => $subscriptions,
        'totals' => [
            'total_invoices' => $totalInvoices,
            'open_invoices' => $openInvoices
        ]
    ]);
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
