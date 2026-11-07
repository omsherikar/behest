import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';

// A software passkey for tests: an ES256 key pair from Node's crypto that answers registration and
// sign-in options as a browser and authenticator would, with `none` attestation. Built by hand from
// the WebAuthn byte layouts, so the server code under test checks real signatures.

/** Authenticator data flags: user present, user verified, attested credential data included. */
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED_CREDENTIAL = 0x40;

const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

export class TestAuthenticator {
  /** The credential id, base64url. */
  readonly credentialId: string;
  /** The COSE public key, as the authenticator hands it over at registration. */
  readonly cosePublicKey: Uint8Array;
  /** The signature counter, which each assertion raises by one unless told otherwise. */
  counter = 0;
  private readonly privateKey: KeyObject;

  /** A passkey for the site at `origin`, whose relying party id is its hostname. */
  constructor(readonly origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    // kty EC2, alg ES256, crv P-256, then the point.
    this.cosePublicKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, 'base64url')],
        [-3, Buffer.from(jwk.y as string, 'base64url')],
      ]),
    );
    this.credentialId = b64url(randomBytes(16));
  }

  private rpIdHash(): Buffer {
    return sha256(new URL(this.origin).hostname);
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string): string {
    return b64url(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** The registration response to `options`, with `none` attestation. */
  register(options: PublicKeyCredentialCreationOptionsJSON, { origin = this.origin } = {}): RegistrationResponseJSON {
    const id = Buffer.from(this.credentialId, 'base64url');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      this.rpIdHash(),
      Buffer.from([USER_PRESENT | USER_VERIFIED | ATTESTED_CREDENTIAL]),
      uint32(this.counter),
      Buffer.alloc(16),
      length,
      id,
      this.cosePublicKey,
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, string>()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: this.clientData('webauthn.create', options.challenge, origin),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /**
   * The assertion answering `options`, signed over the authenticator data and the hash of the client
   * data. The counter goes up by one, or is set to `counter` when given.
   */
  assert(
    options: PublicKeyCredentialRequestOptionsJSON,
    { counter = this.counter + 1, origin = this.origin }: { counter?: number; origin?: string } = {},
  ): AuthenticationResponseJSON {
    this.counter = counter;
    const authData = Buffer.concat([this.rpIdHash(), Buffer.from([USER_PRESENT | USER_VERIFIED]), uint32(counter)]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, origin);
    // ES256 as WebAuthn uses it: ECDSA P-256 over SHA-256, the signature DER-encoded.
    const signature = sign('sha256', Buffer.concat([authData, sha256(Buffer.from(clientDataJSON, 'base64url'))]), this.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: { clientDataJSON, authenticatorData: b64url(authData), signature: b64url(signature) },
      clientExtensionResults: {},
    };
  }
}
