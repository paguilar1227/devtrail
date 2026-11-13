// infra/main.bicep — DevTrail on Azure Container Apps.
// Usage: see SETUP.md. Secrets go to Key Vault; the Container App reads them
// through its managed identity.
targetScope = 'resourceGroup'

@description('Environment name, used in resource names (for example prod or dev)')
param environment string = 'prod'

@description('Azure region')
param location string = resourceGroup().location

@description('Existing Azure Container Registry that holds the devtrail image')
param acrName string

@description('Resource group of the container registry, if different')
param acrResourceGroup string = resourceGroup().name

@description('Image tag to run')
param imageTag string = 'latest'

@description('PostgreSQL admin password')
@secure()
param dbAdminPassword string

@description('DEVTRAIL_API_KEY: the Bearer key for /api/v1 and /mcp')
@secure()
param apiKey string

@description('Gemini API key (embeddings)')
@secure()
param geminiApiKey string

@description('Anthropic API key (metadata, entity extraction, query routing)')
@secure()
param anthropicApiKey string

@description('Azure OpenAI / Foundry endpoint used for RAG answers')
param azureOpenAIEndpoint string

@description('Azure OpenAI / Foundry key')
@secure()
param azureOpenAIKey string

@description('Deployment name for fast RAG answers')
param azureRagDeployment string = 'gpt-5-4'

@description('Deployment name for thorough RAG answers')
param azureDeepRagDeployment string = 'gpt-5-4-pro'

@description('xAI key (X/Twitter URL ingest). Any placeholder disables that source.')
@secure()
param xaiApiKey string

@description('Firecrawl key (HTML article ingest). Any placeholder disables that source.')
@secure()
param firecrawlApiKey string

@description('Supadata key (YouTube transcript ingest). Any placeholder disables that source.')
@secure()
param supadataApiKey string

@description('Web sign-in: api-key (default) or easyauth when Container Apps authentication is configured')
@allowed(['api-key', 'easyauth'])
param authMode string = 'api-key'

@description('Accept ?key= on /mcp for MCP clients that can only be given a URL')
param mcpAllowUrlKey bool = false

@description('IANA time zone used for due-date logic')
param timezone string = 'UTC'

var prefix = 'devtrail-${environment}'

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    prefix: prefix
    location: location
  }
}

module postgresql 'modules/postgresql.bicep' = {
  name: 'postgresql'
  params: {
    prefix: prefix
    location: location
    adminPassword: dbAdminPassword
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    prefix: prefix
    location: location
  }
}

module keyvault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    prefix: prefix
    location: location
    apiKey: apiKey
    geminiApiKey: geminiApiKey
    anthropicApiKey: anthropicApiKey
    azureOpenAIKey: azureOpenAIKey
    xaiApiKey: xaiApiKey
    firecrawlApiKey: firecrawlApiKey
    supadataApiKey: supadataApiKey
    dbConnectionString: postgresql.outputs.connectionString
    storageConnectionString: storage.outputs.connectionString
  }
}

module containerApp 'modules/container-app.bicep' = {
  name: 'container-app'
  params: {
    prefix: prefix
    location: location
    acrName: acrName
    acrResourceGroup: acrResourceGroup
    imageTag: imageTag
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    keyVaultName: keyvault.outputs.keyVaultName
    azureOpenAIEndpoint: azureOpenAIEndpoint
    azureRagDeployment: azureRagDeployment
    azureDeepRagDeployment: azureDeepRagDeployment
    authMode: authMode
    mcpAllowUrlKey: mcpAllowUrlKey
    timezone: timezone
  }
}

output containerAppUrl string = containerApp.outputs.fqdn
output identityPrincipalId string = containerApp.outputs.identityPrincipalId
