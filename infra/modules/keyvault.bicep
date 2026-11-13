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
param azureOpenAIKey string
@secure()
param xaiApiKey string
@secure()
param firecrawlApiKey string
@secure()
param supadataApiKey string
@secure()
param dbConnectionString string
@secure()
param storageConnectionString string

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

var secrets = [
  { name: 'devtrail-api-key', value: apiKey }
  { name: 'gemini-api-key', value: geminiApiKey }
  { name: 'anthropic-api-key', value: anthropicApiKey }
  { name: 'azure-openai-key', value: azureOpenAIKey }
  { name: 'xai-api-key', value: xaiApiKey }
  { name: 'firecrawl-api-key', value: firecrawlApiKey }
  { name: 'supadata-api-key', value: supadataApiKey }
  { name: 'database-url', value: dbConnectionString }
  { name: 'storage-connection-string', value: storageConnectionString }
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
