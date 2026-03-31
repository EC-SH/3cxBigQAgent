"""BigQuery Agent definition using Google ADK."""

import os

from google.adk.agents import LlmAgent
from google.adk.tools.bigquery import BigQueryCredentialsConfig, BigQueryToolset
from google.adk.tools.bigquery.config import BigQueryToolConfig
import google.auth

# Default configuration
DEFAULT_PROJECT_ID = "your-project-id"
DEFAULT_DATASET = "your_dataset"


def create_bigquery_agent(
    project_id: str | None = None,
    default_dataset: str | None = None,
    model: str = "gemini-3-pro-preview"
) -> LlmAgent:
    """Create a BigQuery agent with access to query and explore BigQuery data.
    
    Args:
        project_id: Google Cloud project ID. If None, uses DEFAULT_PROJECT_ID.
        default_dataset: Default BigQuery dataset to use. If None, uses DEFAULT_DATASET.
        model: The Gemini model to use.
    
    Returns:
        Configured LlmAgent with BigQuery tools.
    """
    # Use defaults if not provided
    if project_id is None:
        project_id = os.environ.get("GOOGLE_CLOUD_PROJECT", DEFAULT_PROJECT_ID)
    
    if default_dataset is None:
        default_dataset = os.environ.get("BIGQUERY_DEFAULT_DATASET", DEFAULT_DATASET)
    
    # Get application default credentials
    credentials, _ = google.auth.default()
    
    # Configure BigQuery credentials
    credentials_config = BigQueryCredentialsConfig(
        credentials=credentials,
    )
    
    # Configure BigQuery tool settings with project
    tool_config = BigQueryToolConfig(
        compute_project_id=project_id,
    )
    
    # Create BigQuery toolset
    bigquery_toolset = BigQueryToolset(
        credentials_config=credentials_config,
        bigquery_tool_config=tool_config,
    )
    
    # Create and return the agent
    agent = LlmAgent(
        model=model,
        name="BigQueryAgent",
        description="An AI agent that can query and analyze data in Google BigQuery.",
        instruction=f"""You are a helpful data analyst agent with access to Google BigQuery.

IMPORTANT CONFIGURATION:
- Project ID: {project_id}
- Default Dataset: {default_dataset}

Always use the project "{project_id}" and dataset "{default_dataset}" for all queries unless the user explicitly specifies otherwise.
When writing SQL queries, use the fully qualified table name format: `{project_id}.{default_dataset}.table_name`

Your capabilities include:
- Listing available datasets and tables
- Getting schema information for tables
- Executing SQL queries to answer questions about the data

When a user asks a question:
1. Use the default dataset ({default_dataset}) - do NOT ask the user for project ID or dataset
2. Get table schemas to understand the structure before writing queries
3. Write and execute SQL queries to answer the user's questions
4. Present results in a clear, readable format

Always explain what you're doing and provide context for your answers.
If a query fails, explain the error and try to fix it.
Be concise but thorough in your responses.""",
        tools=[bigquery_toolset],
    )
    
    return agent
