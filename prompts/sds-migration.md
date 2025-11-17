# Web-base to SDS (Session Data Store) Migration

## Context

I need to migrate a pre-web-base v2.1.0 application to web-base v2.1.0 with SDS (Session Data Store) integration for server-side session management. This migration upgrades the authentication system from client-side cookie storage to server-side session storage.

## Why SDS is Required

### Before SDS Integration (Pre-web-base v2.1.0)

-   **Large cookie size**: Tokens stored client-side (access_token, refresh_token, code_verifier)
-   **Security risk**: Sensitive tokens exposed in cookies
-   **Cookie size limits**: 4KB maximum can cause issues
-   **Network overhead**: Tokens sent with every request
-   **HTTP 431 errors**: Request headers too large when cookies accumulate

### After SDS Integration (Web-base v2.1.0)

-   **Tiny cookie size**: Only session ID stored client-side
-   **Enhanced security**: Tokens stored server-side in Redis
-   **No cookie size limits**: Session data stored server-side
-   **Reduced network overhead**: Only session ID transmitted
-   **Centralized session management**: Better control and monitoring

## Architecture Overview

```
Before SDS:
Browser/Client  ----------->  Web-base Frontend  ----------->  Backend/API
+---------------+   Request                          Request
| access_token  | (Big Cookie)             (Forward All Cookies)
|      +        |                           May cause Request
| refresh_token |                          Header Too Big Error
|      +        |                               HTTP 431
| code_verifier |
+---------------+
   (Unsecured)

After SDS:
Browser/Client  ----------->  Web-base Frontend  ----------->  Backend/API
 +----------+     Request          |      ^          Request
 | store_id |  (Tiny Cookie)       |      |       (access_token)
 +----------+                      |      |
                                 store  retrieve
                                   |      |
                                   v      |
                          Session Data Store (SDS)
                             +---------------+
                             | access_token  |
                             |      +        |
                             | refresh_token |
                             |      +        |
                             | code_verifier |
                             +---------------+
                                 (secured)
```

## Prerequisites

1. **SDS Server**: Running SDS server at tcp://sds.127.0.0.1.nip.io:5333
2. **Clean working directory**: Commit or stash any uncommitted changes

## Installation Steps

### Install Dependencies

```bash
npm install @mssfoobar/sds-client@1.0.0
npm install @mssfoobar/logger@1.0.4
```

### Apply Code Changes

The migration involves changes to multiple files. Below are the detailed modifications required:

## File Changes Required

### A. Core Authentication (`web/src/lib/aoh/core/provider/auth/auth.ts`)

This is the most critical file. Key changes include:

**1. Add SDS Client Import:**

```typescript
import SdsClient from "@mssfoobar/sds-client";
```

**2. Add New Cookie Types:**

```typescript
export const COOKIES_TYPE_ENUM = {
	ACCESS_TOKEN: `${envPublic.PUBLIC_COOKIE_PREFIX}_access_token`,
	REFRESH_TOKEN: `${envPublic.PUBLIC_COOKIE_PREFIX}_refresh_token`,
	CODE_VERIFIER: `${envPublic.PUBLIC_COOKIE_PREFIX}_code_verifier`,
	TEMP_SESSION_ID: `${envPublic.PUBLIC_COOKIE_PREFIX}_temp_session_id`, // NEW
	AUTH_SESSION_ID: `${envPublic.PUBLIC_COOKIE_PREFIX}_auth_session_id`, // NEW
};
```

**3. Add Session Data Enum:**

```typescript
export const SESSION_DATA_ENUM = {
	CODE_VERIFIER: "code_verifier",
};
```

**4. Add SDS Client Initialization Function:**

```typescript
export const getSdsClient = async (): Promise<SdsClient> => {
	const client = new SdsClient(envPrivate.SDS_URL);
	client.on("error", (err) => {
		log.error({ err }, "SDS Client error");
	});
	await client.connect();
	return client;
};
```

**5. Update `isUserRedirectedFromIssuer` Function Signature:**
Remove the `request` parameter:

```typescript
// OLD:
export function isUserRedirectedFromIssuer(url: URL, request: Request): boolean {
	return Boolean(request.redirect && url.searchParams.has("session_state") && url.searchParams.has("code"));
}

// NEW:
export function isUserRedirectedFromIssuer(url: URL): boolean {
	return Boolean(url.searchParams.has("session_state") && url.searchParams.has("code"));
}
```

**6. Update `authenticate` Function Signature:**
Add optional `sdsClient` parameter and implement dual authentication flow:

```typescript
// OLD:
export async function authenticate(
	openid_config: Configuration,
	cookies: Cookies,
	request: Request,
	url: URL
): Promise<AuthResult>;

// NEW:
export async function authenticate(
	openid_config: Configuration,
	cookies: Cookies,
	url: URL,
	sdsClient?: SdsClient
): Promise<AuthResult> {
	// Dual authentication flow
	if (sdsClient) {
		return sdsAuthenticationFlow(openid_config, cookies, url, sdsClient);
	} else {
		return basicAuthenticationFlow(openid_config, cookies, url);
	}
}
```

**7. Rename Old `authenticate` to `basicAuthenticationFlow`:**

```typescript
async function basicAuthenticationFlow(openid_config: Configuration, cookies: Cookies, url: URL): Promise<AuthResult> {
	// Original authenticate logic here, with these changes:
	// - Remove all references to 'request' parameter
	// - Update isUserRedirectedFromIssuer call to not pass request
}
```

**8. Implement New `sdsAuthenticationFlow` Function:**

```typescript
async function sdsAuthenticationFlow(
	openid_config: Configuration,
	cookies: Cookies,
	url: URL,
	sdsClient: SdsClient
): Promise<AuthResult> {
	const authSessionId: string | undefined = cookies.get(COOKIES_TYPE_ENUM.AUTH_SESSION_ID);

	if (authSessionId) {
		// Retrieve access token from SDS
		try {
			const accessToken = await sdsClient.authSessionGetAccessToken(authSessionId);
			return onAuthenticationSuccess(cookies, accessToken, { authSessionId: authSessionId });
		} catch (err) {
			log.warn({ err }, "invalid access token. authentication failed");
			return onAuthenticationFailed(cookies);
		}
	}

	if (isUserRedirectedFromIssuer(url)) {
		const originatingUrl = new URL(envPrivate.ORIGIN + url.pathname + url.search);

		const tempSessionId = cookies.get(COOKIES_TYPE_ENUM.TEMP_SESSION_ID);
		if (!tempSessionId) {
			log.warn({ err: "no temp session id cookie found" }, "unable to retrieve code verifier");
			return onAuthenticationFailed(cookies);
		}

		let code_verifier: string;
		try {
			code_verifier = await sdsClient.tempSessionGet(tempSessionId, SESSION_DATA_ENUM.CODE_VERIFIER);
		} catch (err) {
			log.warn({ err }, "unable to retrieve code verifier");
			return onAuthenticationFailed(cookies);
		}

		try {
			const tokenSet: TokenEndpointResponse & TokenEndpointResponseHelpers = await authorizationCodeGrant(
				openid_config,
				originatingUrl,
				{
					pkceCodeVerifier: code_verifier,
				}
			);

			const newAuthSessionId = await sdsClient.authSessionNew(tokenSet.access_token, tokenSet.refresh_token!);

			return onAuthenticationSuccess(cookies, tokenSet.access_token, { authSessionId: newAuthSessionId });
		} catch (err) {
			log.error({ err }, "error retrieving tokens from issuer");

			if ((err as ResponseBodyError).error === "invalid_grant") {
				log.debug(`Invalid grant. This often happens with cookies are not being forwarded.
          Please check that the code is correct.

          Other possible reasons why the code is wrong:
          - Your PUBLIC_DOMAIN env var might be wrong.
          - Access token client login session timeout too large (Keycloak overflow bug).`);
			} else if ((err as ResponseBodyError).error === "unauthorized_client") {
				throw new Error("Invalid client. Please check that the client_id and client_secret are correct.");
			}

			return onAuthenticationFailed(cookies);
		}
	}

	return onAuthenticationFailed(cookies);
}
```

**9. Update `onAuthenticationSuccess` Function:**

```typescript
export function onAuthenticationSuccess(
	cookies: Cookies,
	access_token: string,
	options?: {
		authSessionId?: string; // NEW
		refresh_token?: string;
		access_token_expires_in?: number;
	}
): AuthResultSuccess {
	// If authSessionId is provided, set only AUTH_SESSION_ID cookie
	if (options?.authSessionId) {
		cookies.set(COOKIES_TYPE_ENUM.AUTH_SESSION_ID, options.authSessionId, DEFAULT_COOKIE_OPTIONS);
		cookies.delete(COOKIES_TYPE_ENUM.TEMP_SESSION_ID, expiryCookieOpts());
	} else {
		// Original cookie-based flow
		if (options?.access_token_expires_in) {
			cookies.set(
				COOKIES_TYPE_ENUM.ACCESS_TOKEN,
				access_token,
				expiryCookieOpts(options.access_token_expires_in)
			);
		}

		if (options?.refresh_token) {
			cookies.set(COOKIES_TYPE_ENUM.REFRESH_TOKEN, options.refresh_token, expiryCookieOpts(refreshExpiresIn));
		}

		cookies.delete(COOKIES_TYPE_ENUM.CODE_VERIFIER, expiryCookieOpts());
	}

	return {
		success: true,
		claims: jwtDecode<AuthClaims>(access_token),
		access_token,
	};
}
```

**10. Update `onAuthenticationFailed` Function:**

```typescript
export function onAuthenticationFailed(cookies: Cookies): AuthResultFail {
	// Delete SDS related cookies - ADD THESE FIRST
	cookies.delete(COOKIES_TYPE_ENUM.AUTH_SESSION_ID, expiryCookieOpts());
	cookies.delete(COOKIES_TYPE_ENUM.TEMP_SESSION_ID, expiryCookieOpts());

	// Delete the access token
	cookies.delete(COOKIES_TYPE_ENUM.ACCESS_TOKEN, expiryCookieOpts());
	// Delete the refresh token
	cookies.delete(COOKIES_TYPE_ENUM.REFRESH_TOKEN, expiryCookieOpts());
	// Delete the code verifier
	cookies.delete(COOKIES_TYPE_ENUM.CODE_VERIFIER, expiryCookieOpts());

	return {
		success: false,
	};
}
```

**11. Add `isTenantAdmin` Helper Function:**

```typescript
/**
 * Checks if the user is a tenant admin by decoding the access token and checking
 * if the 'tenant-admin' role exists in the active tenant's roles.
 */
export function isTenantAdmin(accessToken: string): boolean {
	try {
		const claims = jwtDecode<AuthClaims>(accessToken);
		return claims.active_tenant?.roles?.includes("tenant-admin") ?? false;
	} catch (error) {
		log.error({ error }, "failed to decode access token");
		return false;
	}
}
```

**12. Update `sameSite` Cookie Option:**

```typescript
export const DEFAULT_COOKIE_OPTIONS: CookieSerializeOptions & { path: string } = {
	path: "/",
	secure: (envPrivate.ORIGIN ?? "").toLowerCase().startsWith("https://"),
	httpOnly: true,
	sameSite: (envPublic.PUBLIC_COOKIE_SAMESITE as CookieSerializeOptions["sameSite"]) ?? "lax", // CHANGED
};
```

### B. Hooks Server (`web/src/hooks.server.ts`)

**1. Add SDS Client Import:**

```typescript
import { authenticate, LOGIN_API, type AuthResult, getSdsClient } from "$lib/aoh/core/provider/auth/auth";
```

**2. Add Environment Variable Warnings:**

```typescript
if (!envPrivate.SDS_URL) {
	log.warn(`SDS_URL is not set, defaulting to basic authentication flow`);
}

if (!envPrivate.FRAME_ANCESTORS) {
	log.warn(`FRAME_ANCESTORS is not set.`);
}

if (!envPrivate.X_FRAME_OPTIONS) {
	log.warn(`X_FRAME_OPTIONS is not set.`);
}
```

**3. Update Handle Function:**

```typescript
export const handle: Handle = async ({ event, resolve }) => {
	// Initialize SDS client if configured
	let sdsClient = undefined;
	if (envPrivate.SDS_URL) {
		sdsClient = await getSdsClient();
	}

	try {
		// Update authenticate call - REMOVE request parameter, ADD sdsClient
		const authResult: AuthResult = await authenticate(oidc_config, event.cookies, event.url, sdsClient);

		event.locals.clients = {
			oidc_config,
		};
		event.locals.authResult = authResult;

		// Store original URL for redirect after authentication
		if (!authResult.success && !event.url.pathname.startsWith("/aoh/api/auth/")) {
			event.locals.originalUrl = event.url.pathname + event.url.search;
		}
	} catch (err) {
		log.error({ err }, "critical authentication failure");

		if (!building) {
			error(500, {
				message: (err as Error).message,
			});
		}
	} finally {
		// IMPORTANT: Always clean up SDS client
		if (sdsClient) {
			await sdsClient.close();
		}
	}

	const response = await resolve(event);

	// Add security headers
	const frameAncestors = envPrivate.FRAME_ANCESTORS;
	if (frameAncestors) {
		response.headers.set("Content-Security-Policy", `frame-ancestors ${frameAncestors};`);
	}

	const xFrameOptions = envPrivate.X_FRAME_OPTIONS;
	if (xFrameOptions) {
		response.headers.set("X-Frame-Options", xFrameOptions);
	}

	return response;
};
```

### C. API Login Endpoint (`web/src/routes/(public)/aoh/api/auth/login/+server.ts`)

**1. Update Imports:**

```typescript
import {
	COOKIES_TYPE_ENUM,
	DEFAULT_COOKIE_OPTIONS,
	getSdsClient,
	SESSION_DATA_ENUM,
} from "$lib/aoh/core/provider/auth/auth";
import { log } from "$lib/aoh/core/logger/Logger";
```

**2. Update GET Handler:**

```typescript
export const GET: RequestHandler = async (event) => {
	if (!event.locals.clients?.oidc_config) {
		throw new Error("oidc_config missing from locals");
	}

	const oidc_config: Configuration = event.locals.clients.oidc_config;

	const code_verifier = randomPKCECodeVerifier();
	const code_challenge = await calculatePKCECodeChallenge(code_verifier);

	// Always redirect OAuth callbacks to our safe callback handler
	const finalDestination = envPrivate.ORIGIN + "/aoh/api/auth/callback";

	const redirectUrl: URL = buildAuthorizationUrl(oidc_config, {
		redirect_uri: finalDestination,
		scope: "openid profile",
		code_challenge,
		code_challenge_method: "S256",
	});

	// If SDS is configured, cache code verifier at SDS server
	// Otherwise, cache in browser cookie
	if (envPrivate.SDS_URL) {
		const sdsClient = await getSdsClient();
		try {
			const tempSid = await sdsClient.tempSessionNew();
			await sdsClient.tempSessionSet(tempSid, SESSION_DATA_ENUM.CODE_VERIFIER, code_verifier);
			event.cookies.set(COOKIES_TYPE_ENUM.TEMP_SESSION_ID, tempSid, DEFAULT_COOKIE_OPTIONS);
		} catch (err) {
			log.error({ err }, "creating temporary session error");
		} finally {
			await sdsClient.close();
		}
	} else {
		event.cookies.set(COOKIES_TYPE_ENUM.CODE_VERIFIER, code_verifier, DEFAULT_COOKIE_OPTIONS);
	}

	event.setHeaders({
		Location: redirectUrl.href ?? "",
	});

	return json(null, {
		status: StatusCodes.TEMPORARY_REDIRECT,
	});
};
```

### D. API Logout Endpoint (`web/src/routes/(public)/aoh/api/auth/logout/+server.ts`)

**1. Update Imports:**

```typescript
import { COOKIES_TYPE_ENUM, expiryCookieOpts, getSdsClient, LOGIN_API } from "$lib/aoh/core/provider/auth/auth";
import { CONTEXT_COOKIE_NAME } from "$lib/aoh/core/constants";
import { log } from "$lib/aoh/core/logger/Logger";
```

**2. Rewrite GET Handler:**

```typescript
export const GET: RequestHandler = async ({ cookies, locals, setHeaders }) => {
	const origin = env.ORIGIN;
	const LOGIN_PAGE: string = env.LOGIN_PAGE ? env.LOGIN_PAGE : LOGIN_API;

	// SDS Flow
	if (env.SDS_URL) {
		const authSessionId: string | undefined = cookies.get(COOKIES_TYPE_ENUM.AUTH_SESSION_ID);
		cookies.delete(COOKIES_TYPE_ENUM.AUTH_SESSION_ID, expiryCookieOpts(0));

		if (authSessionId) {
			const sdsClient = await getSdsClient();

			await sdsClient
				.authSessionDestroy(authSessionId)
				.catch((err: Error) => {
					log.error({ err }, "error destroying auth session");
				})
				.finally(() => {
					sdsClient.close();
				});
		}
	} else {
		// Cookie-based Flow
		if (!locals.clients?.oidc_config) {
			throw new Error("oidc_config missing from locals");
		}

		const oidc_config: Configuration = locals.clients?.oidc_config;
		const refresh_token: string | undefined = cookies.get(COOKIES_TYPE_ENUM.REFRESH_TOKEN);

		cookies.delete(COOKIES_TYPE_ENUM.REFRESH_TOKEN, expiryCookieOpts(0));
		cookies.delete(COOKIES_TYPE_ENUM.ACCESS_TOKEN, expiryCookieOpts(0));
		cookies.delete(CONTEXT_COOKIE_NAME, expiryCookieOpts(0));

		if (refresh_token && oidc_config) {
			try {
				const tokens: TokenEndpointResponse = await refreshTokenGrant(oidc_config, refresh_token);

				if (!tokens.id_token) {
					return json(null, {
						status: StatusCodes.UNAUTHORIZED,
					});
				}

				const endSessionUrl: URL = buildEndSessionUrl(oidc_config, {
					post_logout_redirect_uri: origin + ("/" + LOGIN_PAGE).replace("//", "/"),
					id_token_hint: tokens.id_token,
				});

				setHeaders({
					Location: endSessionUrl.toString(),
				});

				return json(null, {
					status: StatusCodes.TEMPORARY_REDIRECT,
				});
			} catch (err) {
				log.error({ err }, "error refreshing tokens during logout");
			}
		}
	}

	setHeaders({
		Location: origin + ("/" + LOGIN_PAGE).replace("//", "/"),
	});

	return json(null, {
		status: StatusCodes.TEMPORARY_REDIRECT,
	});
};
```

### E. API Refresh Endpoint (`web/src/routes/(public)/aoh/api/auth/refresh/+server.ts`)

**1. Update Imports:**

```typescript
import { env } from "$env/dynamic/private";
import { COOKIES_TYPE_ENUM, expiryCookieOpts, refreshExpiresIn, getSdsClient } from "$lib/aoh/core/provider/auth/auth";
```

**2. Rewrite GET Handler:**

```typescript
export const GET: RequestHandler = async ({ cookies, locals }) => {
	// SDS Flow
	if (env.SDS_URL) {
		const authSessionId: string | undefined = cookies.get(COOKIES_TYPE_ENUM.AUTH_SESSION_ID);
		if (authSessionId) {
			const sdsClient = await getSdsClient();
			try {
				// Accessing the token refreshes it if necessary
				await sdsClient.authSessionGetAccessToken(authSessionId);
			} catch (e) {
				log.error({ err: e }, "error refreshing tokens");
				cookies.delete(COOKIES_TYPE_ENUM.AUTH_SESSION_ID, expiryCookieOpts());
				const responseBody = {
					message: "Unable to refresh tokens, deleting tokens cookies.",
					sent_at: new Date().toISOString(),
				};

				return json(responseBody, {
					status: StatusCodes.UNAUTHORIZED,
				});
			} finally {
				await sdsClient.close();
			}

			return json(null, {
				status: StatusCodes.OK,
			});
		}
	} else {
		// Cookie-based Flow
		const oidc_config: Configuration | undefined = locals.clients?.oidc_config;
		const refresh_token: string | undefined = cookies.get(COOKIES_TYPE_ENUM.REFRESH_TOKEN);

		if (refresh_token && oidc_config) {
			try {
				const tokens: TokenEndpointResponse = await refreshTokenGrant(oidc_config, refresh_token);
				cookies.set(COOKIES_TYPE_ENUM.ACCESS_TOKEN, tokens.access_token, expiryCookieOpts(tokens.expires_in));
				cookies.set(
					COOKIES_TYPE_ENUM.REFRESH_TOKEN,
					tokens.refresh_token as string,
					expiryCookieOpts(refreshExpiresIn)
				);
				cookies.delete(COOKIES_TYPE_ENUM.CODE_VERIFIER, expiryCookieOpts());
			} catch (e) {
				log.error({ err: e }, "error refreshing tokens");
				cookies.delete(COOKIES_TYPE_ENUM.ACCESS_TOKEN, expiryCookieOpts());
				cookies.delete(COOKIES_TYPE_ENUM.REFRESH_TOKEN, expiryCookieOpts());
				const responseBody = {
					message: "Unable to refresh tokens, deleting tokens cookies.",
					sent_at: new Date().toISOString(),
				};

				return json(responseBody, {
					status: StatusCodes.UNAUTHORIZED,
				});
			}

			return json(null, {
				status: StatusCodes.OK,
			});
		}
	}

	const responseBody = {
		message: "No tokens provided - could not refresh tokens.",
		sent_at: new Date().toISOString(),
	};

	return json(responseBody, {
		status: StatusCodes.UNAUTHORIZED,
	});
};
```

### F. New API Callback Endpoint (`web/src/routes/(public)/aoh/api/auth/callback/+server.ts`)

Create this new file:

```typescript
import { redirect } from "@sveltejs/kit";
import { StatusCodes } from "http-status-codes";
import type { RequestHandler } from "./$types";
import { log as logger } from "$lib/aoh/core/logger/Logger";
import { env as envPrivate } from "$env/dynamic/private";

const log = logger.child({ src: new URL(import.meta.url).pathname });

export const GET: RequestHandler = async ({ cookies }) => {
	// This route handles the final redirect after successful authentication
	// It ensures the user is redirected to their intended destination

	// Check if there's a stored redirect destination
	const redirectDestination = cookies.get("aoh_redirect_after_auth");

	if (redirectDestination) {
		log.debug(`Redirecting user to stored destination: ${redirectDestination}`);
		// Clear the redirect cookie
		cookies.delete("aoh_redirect_after_auth", { path: "/" });
		redirect(StatusCodes.TEMPORARY_REDIRECT, redirectDestination);
	}

	// If no stored destination, redirect to the default landing page
	const defaultDestination = ("/" + envPrivate.LOGIN_DESTINATION).replace("//", "/");
	log.debug(`Redirecting user to default destination: ${defaultDestination}`);
	redirect(StatusCodes.TEMPORARY_REDIRECT, defaultDestination);
};
```

### G. New API Context Endpoints

**1. Create `web/src/routes/(public)/aoh/api/auth/context/+server.ts`:**

```typescript
import type { RequestHandler } from "@sveltejs/kit";
import { CONTEXT_COOKIE_NAME } from "$lib/aoh/core/constants";

export const GET: RequestHandler = async ({ cookies }) => {
	const currentContext = cookies.get(CONTEXT_COOKIE_NAME);

	return new Response(JSON.stringify({ context: currentContext }), {
		status: 200,
		headers: {
			"Content-Type": "application/json",
		},
	});
};
```

**2. Create `web/src/routes/(public)/aoh/api/auth/context/[value]/+server.ts`:**

```typescript
import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import { StatusCodes } from "http-status-codes";
import { CONTEXT_COOKIE_MAX_AGE, CONTEXT_COOKIE_NAME } from "$lib/aoh/core/constants";
import type { RequestHandler } from "./$types";
import { expiryCookieOpts } from "$lib/aoh/core/provider/auth/auth";

export const GET: RequestHandler = async ({ cookies, setHeaders, params }) => {
	const contextValue = params.value;
	const origin = env.ORIGIN;

	cookies.set(CONTEXT_COOKIE_NAME, contextValue, expiryCookieOpts(CONTEXT_COOKIE_MAX_AGE));
	setHeaders({
		Location: origin,
	});

	return json(null, {
		status: StatusCodes.TEMPORARY_REDIRECT,
	});
};
```

### H. New Constants File (`web/src/lib/aoh/core/constants.ts`)

Create this new file:

```typescript
export const CONTEXT_COOKIE_NAME = "context_value";
export const CONTEXT_LABEL_COOKIE_NAME = "context_label";
export const CONTEXT_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
export const CONTEXT_SWITCH_ENDPOINT = "/aoh/api/auth/context";
```

### I. Update Type Definitions (`web/src/app.d.ts`)

Add to `App.Locals` interface:

```typescript
declare global {
	namespace App {
		interface Locals {
			authResult?: AuthResult;
			clients?: {
				oidc_config?: Configuration;
			};
			originalUrl?: string; // ADD THIS LINE
		}
	}
}
```

### J. Update Tests (`web/src/lib/aoh/core/provider/auth/auth.test.ts`)

**Key Changes:**

1. Remove `Request` parameter from all `authenticate()` calls
2. Remove `Request` parameter from `isUserRedirectedFromIssuer()` calls
3. Update cookie references to use `COOKIES_TYPE_ENUM` constants instead of hardcoded strings
4. Update expectations for `onAuthenticationFailed` to expect 5 cookie deletions (not 3)
5. Add `jwt-decode` mock
6. Update `fetchUserInfo` mock to accept 3 parameters
7. Update `refreshTokenGrant` mock to return proper token structure

## Environment Variables

### Required Variables

Add to your `.env` file (and `.env.template`):

```bash
## --------------------- SESSION DATA STORE (SDS) -------------------------
## The URL to the Session Data Store (SDS) server for server-side session management
## If set, authentication tokens will be stored server-side instead of in cookies
## If left empty, the system will use legacy cookie-based authentication
SDS_URL=tcp://sds.127.0.0.1.nip.io:5333

## --------------------- SECURITY HEADERS -------------------------
## Content Security Policy frame-ancestors directive
## Controls which origins can embed this application in frames/iframes
## Example: 'self' https://example.com
FRAME_ANCESTORS='self'

## X-Frame-Options header value
## Controls whether the site can be embedded in frames
## Common values: DENY, SAMEORIGIN, ALLOW-FROM https://example.com
X_FRAME_OPTIONS=SAMEORIGIN

## Cookie SameSite attribute (optional, defaults to 'lax')
PUBLIC_COOKIE_SAMESITE=lax
```

**Note:** Leave `SDS_URL` empty to use legacy cookie-based authentication.

## Testing the Migration

### Run Tests

```bash
npm run test:unit
```

All authentication tests should pass.

### Manual Testing Checklist

-   [ ] Login works and only session ID cookie is set
-   [ ] Token refresh works correctly
-   [ ] Logout cleans up all cookies/sessions
-   [ ] OAuth callback redirect works
-   [ ] Security headers are set (check browser dev tools)
-   [ ] No HTTP 431 errors with large tokens

## Troubleshooting

### SDS Connection Errors

```
Error: SDS Client error
```

**Solution:**

-   Verify SDS server is running
-   Check `SDS_URL` environment variable is set to `tcp://sds.127.0.0.1.nip.io:5333`
-   Review SDS server logs for connection issues

### Infinite Redirect Loops

**Solution:**

-   Verify `PUBLIC_DOMAIN` is set correctly (typically `127.0.0.1.nip.io`)
-   Check OIDC client configuration in Keycloak
-   Ensure redirect URIs include `/aoh/api/auth/callback`

### Missing Code Verifier

```
Error: unable to retrieve code verifier
```

**Solution:**

-   Verify SDS temp session is created in login endpoint
-   Check `TEMP_SESSION_ID` cookie is set
-   Review SDS server logs

### Test Failures

**Cookie name mismatches:**

-   Update all test cookie references to use `COOKIES_TYPE_ENUM`

**Wrong parameter count:**

-   Remove `request` parameter from `authenticate()` calls
-   Update `fetchUserInfo` mock to accept 3 parameters

**Wrong deletion count:**

-   Update `onAuthenticationFailed` to expect 5 deletions

## Key Implementation Principles

### 1. Dual Authentication Flow

The migration maintains **backward compatibility**:

-   **SDS Mode** (when `SDS_URL` is set): Tokens stored server-side
-   **Cookie Mode** (when `SDS_URL` is empty): Original cookie-based flow

### 2. Session ID Types

**TEMP_SESSION_ID:**

-   Short-lived session during OAuth flow
-   Stores `code_verifier` for PKCE
-   Deleted after authentication completes

**AUTH_SESSION_ID:**

-   Long-lived authenticated session
-   Maps to access_token and refresh_token in SDS
-   Automatically refreshed by SDS when needed

### 3. Security Enhancements

-   Tokens never exposed to client-side JavaScript (httpOnly cookies)
-   Reduced network overhead (only session ID transmitted)
-   Centralized session management (easier monitoring/revocation)
-   CSP and X-Frame-Options headers prevent clickjacking

### 4. Error Handling

All SDS operations:

-   Wrap in try-catch blocks
-   Log errors using Pino logger format: `log.error({ err }, "message")`
-   Always close SDS client in `finally` blocks

### 5. Logger Call Signature

**CRITICAL:** Pino logger requires object parameter before message:

```typescript
// ✅ CORRECT
log.error({ err }, "error message");
log.warn({ err: "some context" }, "warning message");

// ❌ WRONG
log.error("error message", err);
log.error("error message", { err });
```

## Post-Migration Checklist

-   [ ] Dependencies installed (@mssfoobar/sds-client, @mssfoobar/logger@1.0.4)
-   [ ] All file changes applied
-   [ ] Environment variables configured
-   [ ] Unit tests passing
-   [ ] Login/logout working correctly
-   [ ] OAuth callback flow works
-   [ ] Security headers set
-   [ ] Logger call signatures correct (object before message)
-   [ ] Cookie sizes reduced (session ID only)
