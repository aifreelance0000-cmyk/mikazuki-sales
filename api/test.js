module.exports = function handler(req, res) {
  res.status(200).json({
    ok: true,
    method: req.method,
    bodyType: typeof req.body,
    hasToken: !!process.env.SALES_LINE_ACCESS_TOKEN,
    time: new Date().toISOString()
  });
};
