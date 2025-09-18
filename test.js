const nodemailer = require('nodemailer');
require('dotenv').config();
const { google } = require('googleapis');

console.log('Sprawdzam zmienne środowiskowe:');
console.log('SMTP_USER:', process.env.SMTP_USER);

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);

oAuth2Client.setCredentials({ 
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN 
});

async function sendTestMail() {
  try {
    console.log('Pobieranie access token...');
    const accessTokenObj = await oAuth2Client.getAccessToken();
    const accessToken = accessTokenObj.token;
    console.log('Access token uzyskany');

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: process.env.SMTP_USER,
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
        accessToken: accessToken,
      },
      tls: {
        // Dodaj te opcje aby pominąć problemy z certyfikatami
        rejectUnauthorized: false
      },
      secure: true, // Upewnij się że używa SSL
    });

    console.log('Wysyłanie maila...');
    const result = await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.SMTP_USER,
      subject: 'Test Gmail OAuth2 - ' + new Date().toLocaleString(),
      text: 'Jeśli to widzisz, OAuth2 działa!',
    });
    
    console.log('✅ Email wysłany pomyślnie!');
    console.log('Message ID:', result.messageId);
    
  } catch (err) {
    console.error('❌ Błąd:');
    console.error('Message:', err.message);
    console.error('Code:', err.code);
    if (err.response) console.error('Response:', err.response);
  }
}

sendTestMail();