// One way to print an amount to a human. numeric(12,2) columns come back
// from Postgres as strings like "45000.00", and that is exactly what
// customers were being texted ("Total KES 45000.00"). Whole shillings print
// without decimals, cents only when present: 45000 -> "45,000", 3333.33 ->
// "3,333.33". The M-Pesa Amount field is a separate integer (mpesa.js) and
// is not formatted through here.
function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return v.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

module.exports = { fmtMoney };
