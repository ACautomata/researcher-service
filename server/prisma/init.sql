-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "maxContainers" INTEGER NOT NULL DEFAULT 3,
    "oidcSubject" TEXT,
    "oidcIssuer" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "replacedByTokenId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "containers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "ownerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "homeDir" TEXT NOT NULL,
    "containerId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'creating',
    "image" TEXT NOT NULL,
    "leaseExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "containers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "pairings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL DEFAULT '',
    "publicKeyPem" TEXT NOT NULL DEFAULT '',
    "privateKeyPem" TEXT NOT NULL DEFAULT '',
    "privateKeyPemEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "deviceToken" TEXT NOT NULL DEFAULT '',
    "deviceTokenEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "scopesJson" TEXT NOT NULL DEFAULT '[]',
    "pairingRequestId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'unpaired',
    "attemptVersion" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "pairings_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "containers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "api" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnvId" TEXT NOT NULL,
    "authHeader" BOOLEAN NOT NULL DEFAULT true,
    "modelsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_providers_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "containers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_oidcIssuer_oidcSubject_key" ON "users"("oidcIssuer", "oidcSubject");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "containers_name_key" ON "containers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "containers_port_key" ON "containers"("port");

-- CreateIndex
CREATE INDEX "containers_ownerId_idx" ON "containers"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "pairings_containerId_key" ON "pairings"("containerId");

-- CreateIndex
CREATE UNIQUE INDEX "model_providers_containerId_providerId_key" ON "model_providers"("containerId", "providerId");

