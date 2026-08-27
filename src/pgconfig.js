// One definition of how we connect to Postgres, shared by the server and the
// scripts. Hosted providers (Supabase, Neon, Railway, the AT platform) all
// require TLS, and their pooler certificates do not verify against the local
// root store, so enable SSL for anything that is not localhost.

function isLocal(url) {
  return /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
}

function poolConfig(connectionString) {
  const cfg = { connectionString };
  if (!isLocal(connectionString) && !/sslmode=disable/.test(connectionString)) {
    cfg.ssl = { rejectUnauthorized: false };
  }
  return cfg;
}

module.exports = { poolConfig, isLocal };
