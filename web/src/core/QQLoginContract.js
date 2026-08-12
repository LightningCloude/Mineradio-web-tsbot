export function normalizeQQLoginPayload(data = {}) {
  const qrKey = data.qr_key || data.key || data.qrsig;
  if (!qrKey || !data.ptqrtoken) {
    throw new Error('二维码会话数据不完整');
  }

  const imageSrc = data.qr_image_base64
    ? `data:image/png;base64,${data.qr_image_base64}`
    : (data.qr_url || data.qr_data || data.qr_image);
  if (!imageSrc) throw new Error('二维码图片缺失');

  return {
    imageSrc,
    session: {
      qrKey,
      ptqrtoken: String(data.ptqrtoken),
      ptLoginSig: data.pt_login_sig || '',
    },
  };
}


export function buildQQLoginCheckQuery(qrSession) {
  const params = new URLSearchParams({
    qr_key: qrSession.qrKey,
    ptqrtoken: qrSession.ptqrtoken,
  });
  if (qrSession.ptLoginSig) params.set('pt_login_sig', qrSession.ptLoginSig);
  return params.toString();
}
