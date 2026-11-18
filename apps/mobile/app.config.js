const { X509Certificate } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { relative, resolve, sep } = require("node:path");

module.exports = ({ config }) => {
  const certificatePath = process.env.FROGCODER_UPDATE_CERT?.trim();
  const updates = {
    enabled: Boolean(certificatePath),
    checkAutomatically: "NEVER",
    fallbackToCacheTimeout: 0,
    enableBsdiffPatchSupport: false,
  };

  if (certificatePath) {
    const certificate = resolve(__dirname, certificatePath);
    const pem = readFileSync(certificate, "utf8").trim();
    if (
      !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----$/.test(
        pem,
      )
    ) {
      throw new Error("FROGCODER_UPDATE_CERT must contain a single public PEM certificate");
    }
    const { publicKey, keyUsage } = new X509Certificate(pem);
    if (
      publicKey.asymmetricKeyType !== "rsa" ||
      publicKey.asymmetricKeyDetails.modulusLength < 2048
    ) {
      throw new Error("Use an RSA update certificate with a key of at least 2048 bits");
    }
    if (!keyUsage?.includes("1.3.6.1.5.5.7.3.3")) {
      throw new Error("The update certificate must include the codeSigning extended key usage");
    }
    Object.assign(updates, {
      url: "https://frogcoder.invalid/v1/mobile-ota/manifest",
      requestHeaders: { "frogcoder-update-url": "" },
      codeSigningCertificate: relative(__dirname, certificate).split(sep).join("/"),
      codeSigningMetadata: { keyid: "root", alg: "rsa-v1_5-sha256" },
    });
  }

  return { ...config, runtimeVersion: { policy: "fingerprint" }, updates };
};
