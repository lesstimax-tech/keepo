/** Opérations fidélité (RPC Supabase + repli client) */
window.KEEPO = window.KEEPO || {};

KEEPO.getClientBalance = async function (merchantId, clientId) {
  const { data, error } = await supabaseClient
    .from("loyalty_balances")
    .select("points")
    .eq("merchant_id", merchantId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  return data ? data.points : 0;
};

KEEPO.applyCreditFallback = async function (merchantId, clientId, amount, points) {
  const { error: txErr } = await supabaseClient.from("transactions").insert([{
    merchant_id: merchantId,
    client_id: clientId,
    amount: amount,
    points_changed: points,
    type: "credit"
  }]);
  if (txErr) throw txErr;

  const current = await KEEPO.getClientBalance(merchantId, clientId);
  const { error: balErr } = await supabaseClient.from("loyalty_balances").upsert({
    merchant_id: merchantId,
    client_id: clientId,
    points: current + points
  }, { onConflict: "merchant_id,client_id" });
  if (balErr) throw balErr;
  return current + points;
};

KEEPO.applyDebitFallback = async function (merchantId, clientId, points) {
  const current = await KEEPO.getClientBalance(merchantId, clientId);
  if (current < points) throw new Error("Solde insuffisant pour cette récompense.");

  const { error: txErr } = await supabaseClient.from("transactions").insert([{
    merchant_id: merchantId,
    client_id: clientId,
    amount: 0,
    points_changed: -points,
    type: "debit"
  }]);
  if (txErr) throw txErr;

  const { error: balErr } = await supabaseClient.from("loyalty_balances").upsert({
    merchant_id: merchantId,
    client_id: clientId,
    points: current - points
  }, { onConflict: "merchant_id,client_id" });
  if (balErr) throw balErr;
  return current - points;
};

KEEPO.applyCredit = async function (merchantId, clientId, amount, points) {
  const { data, error } = await supabaseClient.rpc("apply_loyalty_credit", {
    p_merchant_id: merchantId,
    p_client_id: clientId,
    p_amount: amount,
    p_points: points
  });
  if (!error) return typeof data === "number" ? data : await KEEPO.getClientBalance(merchantId, clientId);
  if (error.code === "PGRST202" || (error.message && error.message.includes("function"))) {
    return KEEPO.applyCreditFallback(merchantId, clientId, amount, points);
  }
  throw error;
};

KEEPO.applyDebit = async function (merchantId, clientId, points) {
  const { data, error } = await supabaseClient.rpc("apply_loyalty_debit", {
    p_merchant_id: merchantId,
    p_client_id: clientId,
    p_points: points
  });
  if (!error) return typeof data === "number" ? data : await KEEPO.getClientBalance(merchantId, clientId);
  if (error.code === "PGRST202" || (error.message && error.message.includes("function"))) {
    return KEEPO.applyDebitFallback(merchantId, clientId, points);
  }
  throw error;
};

KEEPO.loadMerchantHistory = async function (merchantId, limit) {
  limit = limit || 50;
  const { data, error } = await supabaseClient
    .from("transactions")
    .select("*, profiles:client_id(name)")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    const { data: simple, error: err2 } = await supabaseClient
      .from("transactions")
      .select("*")
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (err2) throw err2;
    return simple || [];
  }
  return data || [];
};
