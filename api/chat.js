/**
 * api/chat.js
 *
 * Endpoint do chat de suporte interno (/chat). Recebe historico de mensagens,
 * conversa com OpenAI usando tool-calling, executa as tools (queries em
 * Leona/Paddle/Guru/Stripe + acoes seguras) e devolve a resposta final.
 *
 * Auth: header Authorization: Bearer <SUPPORT_CHAT_TOKEN>
 *
 * Body:
 *   {
 *     messages: [{ role: 'user'|'assistant'|'tool', content, ... }, ...]
 *   }
 *
 * Resposta:
 *   {
 *     reply: { role: 'assistant', content: string },
 *     tool_calls: [{ name, args, result }, ...]   // tudo que rodou nessa rodada
 *   }
 */

import { TOOLS, executeTool } from '../lib/chat-tools.js';

const OPENAI_BASE = 'https://api.openai.com/v1';
const MAX_TOOL_LOOPS = 8; // protecao contra loop infinito

const SYSTEM_PROMPT = `Voce e a assistente de suporte interna do Leona Flow (SaaS de automacao WhatsApp), atendendo o time humano de suporte (NAO clientes finais).

Seu papel: ajudar a investigar e resolver casos de clientes. Voce tem acesso direto aos dados de Leona, Paddle, Guru e Stripe via tools.

Diretrizes:
- Quando o suporte mencionar um email ou account_id, use 'lookup_customer' como PRIMEIRA ferramenta (consulta os 4 gateways em paralelo + retorna insights de inconsistencias).
- Seja DIRETA e sucinta. Nao repita informacoes que o suporte ja viu. Use formatacao Markdown (negrito, listas, codigo) pra deixar a leitura clara.
- Sempre cite os IDs reais (account_id, ctm_xxx, sub_xxx, txn_xxx) que aparecem nos RESULTADOS das tools — sao essenciais pra o suporte agir.

REGRAS CRITICAS DE INTEGRIDADE:
- NUNCA invente IDs, datas, valores ou qualquer dado. Se nao apareceu no resultado de uma tool, voce NAO sabe.
- Se um array de subscriptions vier vazio ([]), diga "nao ha subs" — NAO crie IDs ficticios pra preencher a resposta.
- Se voce nao tem certeza de um valor, chame mais uma tool pra confirmar — nao adivinhe.
- IDs Guru, Paddle e Stripe seguem padroes especificos (ctm_*, sub_*, txn_*, uuid). Confira que voce esta lendo do JSON certo, nao confunda product_id com subscription_id por exemplo.
- Quando uma sub Guru aparece, o filtro 'lookup_customer/search_guru_by_email' TRAZ APENAS subs do produto Leona Flow. Subs de outros produtos do mesmo contato (BOTPRO, etc) sao deliberadamente ocultas pra evitar cancelar coisa errada. Se precisar ver tudo, use _debug_guru_raw.

Quando detectar inconsistencias (cobranca duplicada, divergencia de quantidade, sub orfa), DESTAQUE no inicio da resposta e sugira a acao correta.

Acoes ('cancel_guru_subscription', 'create_paddle_renewal_checkout') so executam quando o suporte pedir explicitamente. Se houver duvida, pergunte antes.

Lembre: hoje a estrategia e migrar todos pra Paddle organicamente. Stripe e legado (todos clientes lah ja deveriam ter cancelado). Guru ainda tem clientes ativos mas migra naturalmente quando o cliente paga uma renovacao via Paddle.

Voce nao tem memoria entre conversas. Cada conversa e independente.`;

function bad(res, code, msg) {
  return res.status(code).json({ error: msg });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return bad(res, 405, 'Metodo nao permitido');

  // Auth simples
  const expected = process.env.SUPPORT_CHAT_TOKEN;
  if (!expected) return bad(res, 500, 'SUPPORT_CHAT_TOKEN nao configurado no servidor');

  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (provided !== expected) return bad(res, 401, 'Token invalido');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return bad(res, 500, 'OPENAI_API_KEY nao configurado no servidor');

  const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return bad(res, 400, 'Campo "messages" obrigatorio (array nao vazio)');
  }

  // Concatena system prompt no inicio (cada chamada o passa explicito,
  // o frontend nao precisa mandar)
  const conversation = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages
  ];

  const toolCallsLog = [];

  try {
    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      const openaiRes = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: conversation,
          tools: TOOLS,
          tool_choice: 'auto'
        })
      });

      const data = await openaiRes.json();

      if (!openaiRes.ok) {
        const errMsg = data?.error?.message || JSON.stringify(data);
        return res.status(openaiRes.status).json({
          error: `OpenAI: ${errMsg}`,
          tool_calls: toolCallsLog
        });
      }

      const choice = data.choices?.[0];
      const msg = choice?.message;
      if (!msg) {
        return res.status(500).json({ error: 'Resposta vazia do OpenAI', raw: data });
      }

      // Sem tool calls: resposta final
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return res.status(200).json({
          reply: {
            role: 'assistant',
            content: msg.content || ''
          },
          tool_calls: toolCallsLog,
          finish_reason: choice.finish_reason,
          usage: data.usage || null
        });
      }

      // Ha tool_calls — adiciona msg do assistant ao historico e executa cada uma
      conversation.push(msg);

      for (const tc of msg.tool_calls) {
        const name = tc.function?.name;
        let args = {};
        try {
          args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch (e) {
          args = { _parse_error: e.message, raw: tc.function?.arguments };
        }

        const result = await executeTool(name, args);
        toolCallsLog.push({ id: tc.id, name, args, result });

        conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result)
        });
      }
    }

    // Saiu do loop sem resposta final
    return res.status(500).json({
      error: `Limite de ${MAX_TOOL_LOOPS} ciclos de tool-calling atingido sem resposta final.`,
      tool_calls: toolCallsLog
    });
  } catch (e) {
    console.error('chat error:', e);
    return res.status(500).json({ error: e.message, tool_calls: toolCallsLog });
  }
}
