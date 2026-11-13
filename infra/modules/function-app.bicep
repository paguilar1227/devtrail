// infra/modules/function-app.bicep
param prefix string
param location string
param appInsightsConnectionString string
param keyVaultName string
param storageAccountName string

@description('CRON expression for consolidation schedule. Default: every 30 minutes.')
param consolidationSchedule string = '0 */30 * * * *'

// Function App needs a dedicated storage account for runtime
resource funcStorageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: replace('${prefix}func', '-', '')
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
}

// App Service Plan (consumption)
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${prefix}-func-plan'
  location: location
  kind: 'functionapp'
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
}

// Managed Identity
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-func-identity'
  location: location
}

// Key Vault Secrets User role for the function identity
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: keyVault
  properties: {
    principalId: identity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6') // Key Vault Secrets User
    principalType: 'ServicePrincipal'
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  dependsOn: [kvRoleAssignment]
  name: '${prefix}-func'
  location: location
  kind: 'functionapp'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    siteConfig: {
      appSettings: [
        { name: 'AzureWebJobsStorage', value: 'DefaultEndpointsProtocol=https;AccountName=${funcStorageAccount.name};AccountKey=${funcStorageAccount.listKeys().keys[0].value}' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'CONSOLIDATION_SCHEDULE', value: consolidationSchedule }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
        { name: 'DATABASE_URL', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=database-url)' }
        { name: 'GEMINI_API_KEY', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=gemini-api-key)' }
        { name: 'ANTHROPIC_API_KEY', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=anthropic-api-key)' }
        { name: 'DEVTRAIL_API_KEY', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=devtrail-api-key)' }
        { name: 'AZURE_STORAGE_CONNECTION_STRING', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=storage-connection-string)' }
        { name: 'AZURE_STORAGE_CONTAINER', value: 'devtrail-files' }
        { name: 'TELEGRAM_BOT_TOKEN', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=telegram-bot-token)' }
        { name: 'TELEGRAM_WEBHOOK_SECRET', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=telegram-webhook-secret)' }
        { name: 'TELEGRAM_CHAT_ID', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=telegram-chat-id)' }
        { name: 'REVIEW_MODE', value: 'hybrid' }
        { name: 'DAILY_DIGEST_ENABLED', value: 'true' }
      ]
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
    }
  }
}

output functionAppName string = functionApp.name
