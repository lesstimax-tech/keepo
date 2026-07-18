/** Authentification et garde de routes KEEPO */
window.KEEPO = window.KEEPO || {};

KEEPO.getSession = async function () {
  if (typeof supabaseClient === "undefined") return null;
  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data.session) return null;
  return data.session;
};

KEEPO.getProfile = async function (userId) {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, name, role")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
};

KEEPO.ensureProfile = async function (session, options) {
  options = options || {};
  let profile = await KEEPO.getProfile(session.user.id);
  if (profile) return profile;

  const meta = session.user.user_metadata || {};
  const name = options.name || meta.name || meta.full_name || "Utilisateur";
  const role = options.role || meta.role || "client";

  const { error } = await supabaseClient.from("profiles").insert([
    { id: session.user.id, name: name, role: role }
  ]);
  if (error && error.code !== "23505") throw error;
  return KEEPO.getProfile(session.user.id);
};

KEEPO.redirectByRole = function (role) {
  window.location.href = role === "commercant" ? "/dashboard-commercant" : "/dashboard-client";
};

KEEPO.signOut = async function () {
  if (typeof supabaseClient !== "undefined") {
    await supabaseClient.auth.signOut();
  }
};

/**
 * @param {'client'|'commercant'|null} requiredRole — null = tout utilisateur connecté
 * @param {{ allowDemo?: boolean }} options
 */
KEEPO.requireAuth = async function (requiredRole, options) {
  options = options || {};
  const demoRequested = new URLSearchParams(window.location.search).get("demo") === "1";

  if (options.allowDemo && demoRequested) {
    return { demo: true, session: null, profile: null };
  }

  const session = await KEEPO.getSession();
  if (!session) {
    window.location.replace("/connexion");
    return null;
  }

  let profile;
  try {
    profile = await KEEPO.ensureProfile(session);
  } catch (e) {
    console.error(e);
    KEEPO.signOut();
    window.location.replace("/connexion");
    return null;
  }

  if (!profile) {
    window.location.replace("/connexion");
    return null;
  }

  if (requiredRole && profile.role !== requiredRole) {
    KEEPO.showToast(
      requiredRole === "commercant"
        ? "Cet espace est réservé aux commerçants."
        : "Cet espace est réservé aux clients.",
      "error"
    );
    setTimeout(function () {
      KEEPO.redirectByRole(profile.role);
    }, 1200);
    return null;
  }

  return { demo: false, session: session, profile: profile };
};

KEEPO.handleOAuthReturn = async function () {
  const hash = window.location.hash || "";
  const search = window.location.search || "";
  if (!hash.includes("access_token") && !search.includes("code=")) {
    return false;
  }

  const session = await KEEPO.getSession();
  if (!session) return false;

  const profile = await KEEPO.ensureProfile(session, { role: "client" });
  if (profile) {
    window.history.replaceState({}, document.title, window.location.pathname);
    KEEPO.redirectByRole(profile.role);
  }
  return true;
};

KEEPO.initConnexionPage = async function () {
  if (await KEEPO.handleOAuthReturn()) return;

  const session = await KEEPO.getSession();
  if (session) {
    try {
      const profile = await KEEPO.ensureProfile(session);
      if (profile) {
        KEEPO.redirectByRole(profile.role);
        return;
      }
    } catch (e) {
      console.error(e);
    }
  }
};

KEEPO.requestPasswordReset = async function (email) {
  const redirectTo = window.location.origin + "/connexion";
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: redirectTo
  });
  if (error) throw error;
};
