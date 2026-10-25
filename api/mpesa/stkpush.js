import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, amount, orgId } = req.body;
  
  if (!phone || !amount || !orgId) {
    return res.status(400).json({ error: 'Missing required fields (phone, amount, orgId)' });
  }

  // Safaricom Endpoints
  const baseUrl = process.env.MPESA_ENV === 'production' 
    ? 'https://api.safaricom.co.ke' 
    : 'https://sandbox.safaricom.co.ke';

  // Force the shortcode to your Till number to prevent env variable issues
  const shortcode = process.env.MPESA_SHORTCODE || '1347027'; 

  try {
    // 1. Get OAuth Token
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    const { data: { access_token } } = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` }
    });

    // 2. Generate Password & Timestamp
    // Safaricom requires the timestamp to be in YYYYMMDDHHmmss format
    const date = new Date();
    const timestamp = date.getFullYear() +
      ("0" + (date.getMonth() + 1)).slice(-2) +
      ("0" + date.getDate()).slice(-2) +
      ("0" + date.getHours()).slice(-2) +
      ("0" + date.getMinutes()).slice(-2) +
      ("0" + date.getSeconds()).slice(-2);
      
    const password = Buffer.from(`${shortcode}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');

    // 3. Initiate STK Push
    const stkRes = await axios.post(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline', // <-- CRITICAL FIX FOR TILL NUMBER
      Amount: Math.round(amount), // Safaricom requires whole numbers for KES
      PartyA: phone,
      PartyB: shortcode,          // For Till, PartyB is also the Till number
      PhoneNumber: phone,
      CallBackURL: `https://${req.headers.host}/api/mpesa/callback`,
      AccountReference: 'MOBIBIZ', // Till numbers don't use AccountReference the same way, but it's required
      TransactionDesc: 'POS Subscription'
    }, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    res.status(200).json({ ok: true, data: stkRes.data });
  } catch (error) {
    // Log the EXACT error from Safaricom to Vercel
    const errorData = error.response?.data || error.message;
    console.error('SAFARICOM STK ERROR:', JSON.stringify(errorData, null, 2));
    
    res.status(500).json({ 
      error: 'Failed to initiate M-Pesa payment',
      details: errorData 
    });
  }
}
