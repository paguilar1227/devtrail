// infra/main.bicep
targetScope = 'resourceGroup'

@description('Environment name (dev, prod)')
param environment string = 'prod'

@description('Azure region')
param location string = resourceGroup().location

@description('Shared ACR name (existing)')
param acrName string

@description('ACR resource group (if different)')
param acrResourceGroup string = resourceGroup().name

@description('PostgreSQL admin password')
@secure()
param dbAdminPassword string

@description('Open Brain API key')
@secure()
param apiKey string

@description('Gemini API key')
@secure()
param geminiApiKey string

@description('Anthropic API key')
@secure()
param anthropicApiKey string

@description('Telegram bot token')
@secure()
param telegramBotToken string

@description('Telegram webhook secret')
@secure()
param telegramWebhookSecret string

@description('Telegram chat ID')
param telegramChatId string

@description('Consolidation CRON schedule (Azure Functions format). Default: every 30 min.')
param consolidationSchedule string = '0 */30 * * * *'

var prefix = 'openbrain-${environment}'

// Log Analytics Workspace (required by Container Apps + App Insights)
module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    prefix: prefix
    location: location
  }
}

// Azure Key Vault
module keyvault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    prefix: prefix
    location: location
    apiKey: apiKey
    geminiApiKey: geminiApiKey
    anthropicApiKey: anthropicApiKey
    telegramBotToken: telegramBotToken
    telegramWebhookSecret: telegramWebhookSecret
    dbConnectionString: postgresql.outputs.connectionString
    storageConnectionString: storage.outputs.connectionString
    telegramChatId: telegramChatId
  }
}

// Azure Database for PostgreSQL Flexible Server
module postgresql 'modules/postgresql.bicep' = {
  name: 'postgresql'
  params: {
    prefix: prefix
    location: location
    adminPassword: dbAdminPassword
  }
}

// Azure Blob Storage
module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    prefix: prefix
    location: location
  }
}

// Azure Container App (API + MCP + Telegram webhook)
module containerApp 'modules/container-app.bicep' = {
  name: 'container-app'
  params: {
    prefix: prefix
    location: location
    acrName: acrName
    acrResourceGroup: acrResourceGroup
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    keyVaultName: keyvault.outputs.keyVaultName
  }
}

// Azure Function App (consolidation timer trigger)
module functionApp 'modules/function-app.bicep' = {
  name: 'function-app'
  params: {
    prefix: prefix
    location: location
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    keyVaultName: keyvault.outputs.keyVaultName
    storageAccountName: storage.outputs.storageAccountName
    consolidationSchedule: consolidationSchedule
  }
}

output containerAppUrl string = containerApp.outputs.fqdn
output functionAppName string = functionApp.outputs.functionAppName
