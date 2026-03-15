// infra/modules/keyvault.bicep
param prefix string
param location string

@secure()
param apiKey string
@secure()
param geminiApiKey string
@secure()
param anthropicApiKey string
@secure()
param telegramBotToken string
@secure()
param telegramWebhookSecret string
@secure()
param dbConnectionString string
@secure()
param storageConnectionString string
param telegramChatId string

var vaultName = replace('${prefix}-kv', '-', '')

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

// Store all secrets
var secrets = [
  { name: 'open-brain-api-key', value: apiKey }
  { name: 'gemini-api-key', value: geminiApiKey }
  { name: 'anthropic-api-key', value: anthropicApiKey }
  { name: 'telegram-bot-token', value: telegramBotToken }
  { name: 'telegram-webhook-secret', value: telegramWebhookSecret }
  { name: 'database-url', value: dbConnectionString }
  { name: 'storage-connection-string', value: storageConnectionString }
  { name: 'telegram-chat-id', value: telegramChatId }
]

resource keyVaultSecrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [
  for secret in secrets: {
    parent: keyVault
    name: secret.name
    properties: {
      value: secret.value
    }
  }
]

output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
