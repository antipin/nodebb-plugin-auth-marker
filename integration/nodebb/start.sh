#!/bin/bash
# Boots a throwaway NodeBB with the packed plugin installed and activated.
# Runs inside ghcr.io/nodebb/nodebb (see integration/docker-compose.yml).
set -euo pipefail
cd /usr/src/app

CONFIG=/tmp/config.json

npm install --no-save --no-audit --no-fund /plugin/plugin.tgz

./nodebb setup "$(cat <<JSON
{
  "url": "http://localhost:4567",
  "secret": "test-secret",
  "database": "mongo",
  "mongo:host": "mongo",
  "mongo:port": 27017,
  "mongo:database": "nodebb",
  "mongo:username": "",
  "mongo:password": "",
  "admin:username": "${ADMIN_USERNAME}",
  "admin:password": "${ADMIN_PASSWORD}",
  "admin:password:confirm": "${ADMIN_PASSWORD}",
  "admin:email": "admin@example.com"
}
JSON
)" --config="$CONFIG"

# NodeBB counts every login per IP (successful ones too) and locks the IP after 20 an
# hour. The tests log in many times from one IP, so lift the limit on this throwaway forum.
node -e "
const { MongoClient } = require('mongodb');
(async () => {
	const client = await MongoClient.connect('mongodb://mongo:27017');
	const { matchedCount } = await client.db('nodebb').collection('objects').updateOne(
		{ _key: 'config' },
		{ \$set: { ipLoginAttempts: 100000 } },
	);
	await client.close();
	if (matchedCount !== 1) {
		console.error('start.sh: config object not found, could not raise ipLoginAttempts');
		process.exit(1);
	}
})().catch((err) => { console.error(err); process.exit(1); });
"

# A file in /uploads for the proxy tests (served at /assets/uploads/...)
mkdir -p public/uploads/files
echo "auth-marker upload probe" > public/uploads/files/probe.txt

./nodebb activate nodebb-plugin-auth-marker --config="$CONFIG"
./nodebb build --config="$CONFIG"
exec node app.js --config="$CONFIG"
