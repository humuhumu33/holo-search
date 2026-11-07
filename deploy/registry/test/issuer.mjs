// A test OIDC issuer, for running the gateway on one machine: serves a JWKS
// and mints tokens shaped like GitHub Actions' for any repository you name.
//   node test/issuer.mjs 127.0.0.1:5002            serve the keys
//   node test/issuer.mjs 127.0.0.1:5002 --mint owner/name   print one token
// Point the gateway at it: OIDC_ISSUER=http://127.0.0.1:5002 OIDC_JWKS_URL=http://127.0.0.1:5002/.well-known/jwks
// The key pair is generated on first run and kept in test/issuer-key.json.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";

const listen = process.argv[2] ?? "127.0.0.1:5002";
const issuer = `http://${listen}`;
const keyFile = new URL("./issuer-key.json", import.meta.url);
let pem;
try {
  pem = JSON.parse(await readFile(keyFile, "utf8")).privateKey;
} catch {
  pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  await writeFile(keyFile, JSON.stringify({ privateKey: pem }));
}
const privateKey = createPrivateKey(pem);
const jwk = { ...createPublicKey(privateKey).export({ format: "jwk" }), kid: "test-1", alg: "RS256", use: "sig" };
const b64url = (data) => Buffer.from(data).toString("base64url");

const mint = (repository) => {
  const now = Math.floor(Date.now() / 1000);
  const [owner] = repository.split("/");
  const claims = { iss: issuer, aud: "prism-registry", sub: `repo:${repository}:ref:refs/heads/main`, repository, repository_owner: owner, ref: "refs/heads/main", sha: "0".repeat(40), run_id: "1", workflow_ref: `${repository}/.github/workflows/pages.yml@refs/heads/main`, job_workflow_ref: `${repository}/.github/workflows/pages.yml@refs/heads/main`, iat: now, nbf: now - 10, exp: now + 600 };
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-1" }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
};

const at = process.argv.indexOf("--mint");
if (at > 0) {
  process.stdout.write(mint(process.argv[at + 1]));
  process.exit(0);
}
const [host, port] = listen.split(":");
http.createServer((req, res) => {
  if (req.url === "/.well-known/jwks") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ keys: [jwk] }));
  }
  res.writeHead(404);
  res.end();
}).listen(Number(port), host, () => console.log(`test issuer ${issuer}`));
