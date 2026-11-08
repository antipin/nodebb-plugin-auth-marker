#!/bin/bash
# Boots a throwaway NodeBB with the packed plugin installed and activated.
# Runs inside ghcr.io/nodebb/nodebb (see test/docker-compose.yml).
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
	await client.db('nodebb').collection('objects').updateOne(
		{ _key: 'config' },
		{ \$set: { ipLoginAttempts: 100000 } },
	);
	await client.close();
})();
"

./nodebb activate nodebb-plugin-auth-marker --config="$CONFIG"
./nodebb build --config="$CONFIG"
exec node app.js --config="$CONFIG"
