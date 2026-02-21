const { createServer } = require('https')
const next = require('next')
const fs = require('fs')
const path = require('path')

const dev = true
const app = next({ dev })
const handle = app.getRequestHandler()

const certPath = path.resolve(__dirname, '../certs')

// Dynamically find mkcert files
const files = fs.readdirSync(certPath);
const keyFile = files.find(f => f.includes('key.pem')) || 'key.pem';
const certFile = files.find(f => f.includes('.pem') && !f.includes('key.pem')) || 'cert.pem';

const httpsOptions = {
  key: fs.readFileSync(path.join(certPath, keyFile)),
  cert: fs.readFileSync(path.join(certPath, certFile)),
}

app.prepare().then(() => {
  createServer(httpsOptions, (req, res) => {
    handle(req, res)
  }).listen(3001, '0.0.0.0', (err) => {
    if (err) throw err
    const displayHost = process.env.PUBLIC_IP || 'your-ip'
    console.log('🚀 Next.js running at:')
    console.log(`👉 https://${displayHost}:3001`)
  })
})
