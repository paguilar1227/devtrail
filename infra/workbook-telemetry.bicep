// infra/workbook-telemetry.bicep
//
// Single Application Insights workbook with the queries we want to
// glance at: per-span counts/latency, span volume over time, RAG
// depth split, MCP tool breakdown, recent failures, and our own
// App Insights ingestion volume against the 1 GB/month soft target.
//
// Deploy standalone (does not touch any other infra):
//   az deployment group create \
//     -g openbrain-rg \
//     -f infra/workbook-telemetry.bicep \
//     --parameters appInsightsId=$(az monitor app-insights component show \
//       -g openbrain-rg --app openbrain-prod-insights --query id -o tsv)

targetScope = 'resourceGroup'

@description('Resource ID of the Application Insights component this workbook queries')
param appInsightsId string

@description('Azure region. Defaults to the resource group location.')
param location string = resourceGroup().location

var workbookContent = {
  version: 'Notebook/1.0'
  items: [
    {
      type: 1
      content: {
        json: '# Open Brain — Telemetry Overview\n\nLive view of custom spans, request latency, errors, and our own telemetry-volume budget.\n\nDefault window: **last 24 hours**. Use the time-range picker at the top to widen.'
      }
      name: 'header'
    }
    {
      type: 9
      content: {
        version: 'KqlParameterItem/1.0'
        parameters: [
          {
            id: 'time-range'
            version: 'KqlParameterItem/1.0'
            name: 'TimeRange'
            type: 4
            value: { durationMs: 86400000 }
            typeSettings: {
              selectableValues: [
                { durationMs: 3600000 }
                { durationMs: 21600000 }
                { durationMs: 86400000 }
                { durationMs: 259200000 }
                { durationMs: 604800000 }
                { durationMs: 2592000000 }
              ]
            }
          }
        ]
      }
      name: 'time-picker'
    }
    {
      type: 1
      content: { json: '## Custom spans\n\nThe five span shapes our service emits. Look for sudden p95 jumps or success-rate dips.' }
      name: 'custom-spans-header'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'AppDependencies\n| where Name in (\'rag.query\',\'search.query\',\'content.create\',\'content.ingest_tail\',\'mcp.tool\')\n| summarize\n    count = count(),\n    avg_ms = round(avg(DurationMs), 1),\n    p95_ms = round(percentile(DurationMs, 95), 1),\n    p99_ms = round(percentile(DurationMs, 99), 1),\n    success_rate_pct = round(countif(Success) * 100.0 / count(), 1)\n  by Name\n| order by Name'
        size: 0
        title: 'Span counts and latency'
        timeContext: { durationMs: 86400000 }
        timeContextFromParameter: 'TimeRange'
        queryType: 0
        resourceType: 'microsoft.insights/components'
        visualization: 'table'
      }
      name: 'span-table'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'AppDependencies\n| where Name in (\'rag.query\',\'search.query\',\'content.create\',\'content.ingest_tail\',\'mcp.tool\')\n| summarize count() by bin(TimeGenerated, 1h), Name\n| render areachart'
        size: 0
        title: 'Span volume over time (hourly)'
        timeContext: { durationMs: 86400000 }
        timeContextFromParameter: 'TimeRange'
        queryType: 0
        resourceType: 'microsoft.insights/components'
        visualization: 'areachart'
      }
      name: 'span-volume'
    }
    {
      type: 1
      content: { json: '## RAG depth + MCP tool breakdown\n\nWhich code paths are getting exercised, and how slow are they?' }
      name: 'breakdown-header'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'AppDependencies\n| where Name == \'rag.query\'\n| extend depth = tostring(Properties.[\'rag.depth_requested\'])\n| summarize count = count(), avg_ms = round(avg(DurationMs), 1), p95_ms = round(percentile(DurationMs, 95), 1) by depth\n| order by count desc'
        size: 0
        title: 'RAG by requested depth'
        timeContext: { durationMs: 86400000 }
        timeContextFromParameter: 'TimeRange'
        queryType: 0
        resourceType: 'microsoft.insights/components'
        visualization: 'table'
      }
      name: 'rag-depth'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'AppDependencies\n| where Name == \'mcp.tool\'\n| extend tool_name = tostring(Properties.[\'mcp.tool_name\'])\n| summarize count = count(), avg_ms = round(avg(DurationMs), 1), p95_ms = round(percentile(DurationMs, 95), 1) by tool_name\n| order by count desc'
        size: 0
        title: 'MCP tool calls by name'
        timeContext: { durationMs: 86400000 }
        timeContextFromParameter: 'TimeRange'
        queryType: 0
        resourceType: 'microsoft.insights/components'
        visualization: 'table'
      }
      name: 'mcp-tools'
    }
    {
      type: 1
      content: { json: '## Errors and failures\n\nFailed incoming requests and failed dependencies. Empty is good.' }
      name: 'errors-header'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'union\n  (AppRequests | where Success == false | project TimeGenerated, source = "request", Name, ResultCode = tostring(ResultCode), DurationMs, OperationId),\n  (AppDependencies | where Success == false | project TimeGenerated, source = "dependency", Name, ResultCode = tostring(ResultCode), DurationMs, OperationId)\n| order by TimeGenerated desc\n| take 50'
        size: 0
        title: 'Recent failures'
        timeContext: { durationMs: 86400000 }
        timeContextFromParameter: 'TimeRange'
        queryType: 0
        resourceType: 'microsoft.insights/components'
        visualization: 'table'
      }
      name: 'failures'
    }
    {
      type: 1
      content: { json: '## Telemetry budget\n\nOur own ingestion volume against the 1 GB/month soft target. If `total_GB` ever projects past ~0.7 GB for the month, that\'s the trigger to either drop noisy spans or wire the blob-archive path.' }
      name: 'budget-header'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'Usage\n| where TimeGenerated > ago(30d)\n| where IsBillable\n| summarize total_GB = round(sum(Quantity) / 1024.0, 4) by bin(TimeGenerated, 1d), DataType\n| render columnchart'
        size: 0
        title: 'Daily ingestion by data type (last 30 days)'
        timeContext: { durationMs: 2592000000 }
        queryType: 0
        resourceType: 'microsoft.operationalinsights/workspaces'
        visualization: 'columnchart'
      }
      name: 'usage-daily'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'Usage\n| where TimeGenerated > startofmonth(now())\n| where IsBillable\n| summarize mtd_GB = round(sum(Quantity) / 1024.0, 4)\n| extend cap_GB = 1.0, pct_of_cap = round(mtd_GB / 1.0 * 100, 1)'
        size: 0
        title: 'Month-to-date ingestion vs 1 GB target'
        queryType: 0
        resourceType: 'microsoft.operationalinsights/workspaces'
        visualization: 'table'
      }
      name: 'usage-mtd'
    }
  ]
  fallbackResourceIds: [appInsightsId]
  '$schema': 'https://github.com/Microsoft/Application-Insights-Workbooks/blob/master/schema/workbook.json'
}

resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  name: guid(resourceGroup().id, 'open-brain-telemetry-overview')
  location: location
  kind: 'shared'
  properties: {
    displayName: 'Open Brain — Telemetry Overview'
    serializedData: string(workbookContent)
    version: 'Notebook/1.0'
    sourceId: appInsightsId
    category: 'workbook'
  }
}

output workbookId string = workbook.id
output workbookName string = workbook.name
