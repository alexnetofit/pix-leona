/**
 * Qty inicial do seletor na /assinatura quando o ciclo venceu.
 * Espelho de lib/assinatura-qty.js (browser, sem import).
 */
(function (global) {
  function qtyFromPlanName(name) {
    const match = String(name || '').match(/(\d+)\s*conex/i);
    if (!match) return null;
    const n = parseInt(match[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function subTime(sub) {
    return Number(sub?.status_at || sub?.started_at || 0) || 0;
  }

  function invoiceWhen(inv) {
    return String(inv?.period_end || inv?.charge_at || '');
  }

  function resolveExpiredCheckoutQty({
    leonaQty,
    subscriptions = [],
    invoices = []
  } = {}) {
    const fromLeona = Number(leonaQty);
    if (Number.isFinite(fromLeona) && fromLeona > 0) return fromLeona;

    const ranked = [...subscriptions].sort((a, b) => {
      const diff = subTime(b) - subTime(a);
      if (diff) return diff;
      return String(b.cycle_end || '').localeCompare(String(a.cycle_end || ''));
    });
    const charged = ranked.filter((s) => Number(s.charged_times) > 0);
    for (const sub of charged.length ? charged : ranked) {
      const qty = qtyFromPlanName(sub.offer_name);
      if (qty) return qty;
    }

    const paid = [...invoices]
      .filter((inv) => String(inv.status || '').toLowerCase() === 'paid')
      .sort((a, b) => invoiceWhen(b).localeCompare(invoiceWhen(a)));
    for (const inv of paid) {
      const qty = qtyFromPlanName(inv.offer_name);
      if (qty) return qty;
    }

    return 1;
  }

  global.AssinaturaQty = { qtyFromPlanName, resolveExpiredCheckoutQty };
})(typeof globalThis !== 'undefined' ? globalThis : window);
