#!/usr/bin/env bash
set -euo pipefail

# Rebuilds this project on AWS using CLI only (destroy/create/deploy).
# Usage:
#   scripts/aws_cli_rebuild.sh destroy
#   scripts/aws_cli_rebuild.sh create
#   scripts/aws_cli_rebuild.sh deploy
#   scripts/aws_cli_rebuild.sh all
#
# Required env vars:
#   AWS_REGION
#   LAMBDA_ROLE_ARN
#   EB_EC2_INSTANCE_PROFILE
#   EB_SERVICE_ROLE
#
# Optional env vars:
#   PROJECT_PREFIX          (default: fne-thermal)
#   RACK_ID                 (default: rack_01)
#   RACK_IDS                (default: rack_01,rack_02,rack_03)
#   DATACENTER_ID           (default: DC-01)
#   SENSOR_FREQUENCY        (default: 30)
#   DISPATCH_RATE           (default: 1)

PROJECT_PREFIX="${PROJECT_PREFIX:-fne-thermal}"
AWS_REGION="${AWS_REGION:-}"
RACK_ID="${RACK_ID:-rack_01}"
RACK_IDS="${RACK_IDS:-rack_01,rack_02,rack_03}"
DATACENTER_ID="${DATACENTER_ID:-DC-01}"
SENSOR_FREQUENCY="${SENSOR_FREQUENCY:-30}"
DISPATCH_RATE="${DISPATCH_RATE:-1}"

APP_NAME="${PROJECT_PREFIX}-app"
EDGE_ENV_NAME="${PROJECT_PREFIX}-edge"
CLOUD_ENV_NAME="${PROJECT_PREFIX}-cloud"
QUEUE_NAME="${PROJECT_PREFIX}-queue"
TABLE_NAME="${PROJECT_PREFIX}-table"
LAMBDA_NAME="${PROJECT_PREFIX}-fog-lambda"

LAMBDA_ROLE_ARN="${LAMBDA_ROLE_ARN:-}"
EB_EC2_INSTANCE_PROFILE="${EB_EC2_INSTANCE_PROFILE:-}"
EB_SERVICE_ROLE="${EB_SERVICE_ROLE:-}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing command: $1"
    exit 1
  }
}

require_region() {
  if [[ -z "${AWS_REGION}" ]]; then
    echo "Set AWS_REGION first."
    exit 1
  fi
}

require_create_vars() {
  require_region
  for v in LAMBDA_ROLE_ARN EB_EC2_INSTANCE_PROFILE EB_SERVICE_ROLE; do
    if [[ -z "${!v}" ]]; then
      echo "Set ${v} before create/deploy."
      exit 1
    fi
  done
}

queue_url() {
  aws sqs get-queue-url \
    --queue-name "${QUEUE_NAME}" \
    --region "${AWS_REGION}" \
    --query "QueueUrl" \
    --output text 2>/dev/null || true
}

queue_arn() {
  local qurl
  qurl="$(queue_url)"
  if [[ -z "${qurl}" ]]; then
    echo ""
    return
  fi
  aws sqs get-queue-attributes \
    --queue-url "${qurl}" \
    --attribute-names QueueArn \
    --region "${AWS_REGION}" \
    --query "Attributes.QueueArn" \
    --output text
}

package_zip() {
  local src_dir="$1"
  local out_zip="$2"
  (
    cd "${ROOT_DIR}/${src_dir}"
    rm -f "${ROOT_DIR}/${out_zip}"
    zip -qr "${ROOT_DIR}/${out_zip}" . \
      -x "*.pyc" \
      -x "__pycache__/*" \
      -x ".venv/*" \
      -x ".DS_Store"
  )
}

update_lambda_config_with_retry() {
  local attempts=0
  local max_attempts=12
  local sleep_s=5
  while true; do
    local out
    if out="$(aws lambda update-function-configuration \
      --function-name "${LAMBDA_NAME}" \
      --environment "Variables={DYNAMODB_TABLE_NAME=${TABLE_NAME}}" \
      --region "${AWS_REGION}" 2>&1)"; then
      return 0
    fi
    attempts=$((attempts + 1))
    if [[ "${out}" == *"ResourceConflictException"* ]] && (( attempts < max_attempts )); then
      echo "Lambda config update busy (attempt ${attempts}/${max_attempts}), retrying in ${sleep_s}s..."
      sleep "${sleep_s}"
      continue
    fi
    echo "${out}" >&2
    return 1
  done
}

create_or_update_lambda() {
  local qarn
  qarn="$(queue_arn)"
  if [[ -z "${qarn}" ]]; then
    echo "Queue ARN not found; cannot wire Lambda trigger."
    exit 1
  fi

  package_zip "lambda_fog" "fog-lambda.zip"

  local fn_exists
  fn_exists="$(aws lambda get-function --function-name "${LAMBDA_NAME}" --region "${AWS_REGION}" --query 'Configuration.FunctionName' --output text 2>/dev/null || true)"

  if [[ -z "${fn_exists}" || "${fn_exists}" == "None" ]]; then
    echo "Creating Lambda ${LAMBDA_NAME}..."
    aws lambda create-function \
      --function-name "${LAMBDA_NAME}" \
      --runtime python3.12 \
      --handler lambda_function.lambda_handler \
      --role "${LAMBDA_ROLE_ARN}" \
      --zip-file "fileb://${ROOT_DIR}/fog-lambda.zip" \
      --timeout 30 \
      --region "${AWS_REGION}" >/dev/null
    # New functions may remain in Pending for a short time.
    aws lambda wait function-active --function-name "${LAMBDA_NAME}" --region "${AWS_REGION}"
  else
    echo "Updating Lambda ${LAMBDA_NAME} code..."
    aws lambda update-function-code \
      --function-name "${LAMBDA_NAME}" \
      --zip-file "fileb://${ROOT_DIR}/fog-lambda.zip" \
      --region "${AWS_REGION}" >/dev/null
    aws lambda wait function-updated --function-name "${LAMBDA_NAME}" --region "${AWS_REGION}"
  fi

  update_lambda_config_with_retry

  aws lambda wait function-updated --function-name "${LAMBDA_NAME}" --region "${AWS_REGION}"

  local existing_map_uuid
  existing_map_uuid="$(aws lambda list-event-source-mappings \
    --function-name "${LAMBDA_NAME}" \
    --event-source-arn "${qarn}" \
    --region "${AWS_REGION}" \
    --query "EventSourceMappings[0].UUID" \
    --output text 2>/dev/null || true)"

  if [[ -z "${existing_map_uuid}" || "${existing_map_uuid}" == "None" ]]; then
    echo "Creating SQS -> Lambda trigger..."
    aws lambda create-event-source-mapping \
      --function-name "${LAMBDA_NAME}" \
      --event-source-arn "${qarn}" \
      --batch-size 5 \
      --enabled \
      --region "${AWS_REGION}" >/dev/null
  else
    echo "SQS trigger already exists: ${existing_map_uuid}"
  fi
}

create_queue() {
  echo "Creating/ensuring SQS queue ${QUEUE_NAME}..."
  aws sqs create-queue \
    --queue-name "${QUEUE_NAME}" \
    --region "${AWS_REGION}" >/dev/null
  echo "Queue URL: $(queue_url)"
}

create_table() {
  local exists
  exists="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${AWS_REGION}" --query 'Table.TableName' --output text 2>/dev/null || true)"
  if [[ -z "${exists}" || "${exists}" == "None" ]]; then
    echo "Creating DynamoDB table ${TABLE_NAME}..."
    aws dynamodb create-table \
      --table-name "${TABLE_NAME}" \
      --attribute-definitions \
        AttributeName=rack_id,AttributeType=S \
        AttributeName=sensor_timestamp,AttributeType=S \
      --key-schema \
        AttributeName=rack_id,KeyType=HASH \
        AttributeName=sensor_timestamp,KeyType=RANGE \
      --billing-mode PAY_PER_REQUEST \
      --region "${AWS_REGION}" >/dev/null
    aws dynamodb wait table-exists --table-name "${TABLE_NAME}" --region "${AWS_REGION}"
  else
    echo "DynamoDB table exists: ${TABLE_NAME}"
  fi

  echo "Enabling TTL on expiry_timestamp..."
  local ttl_out
  if ! ttl_out="$(aws dynamodb update-time-to-live \
    --table-name "${TABLE_NAME}" \
    --time-to-live-specification "Enabled=true,AttributeName=expiry_timestamp" \
    --region "${AWS_REGION}" 2>&1 >/dev/null)"; then
    if [[ "${ttl_out}" == *"TimeToLive is already enabled"* ]]; then
      echo "TTL is already enabled."
    else
      echo "${ttl_out}" >&2
      exit 1
    fi
  fi
}

resolve_platform_arn() {
  # Prefer AL2023 Python platform, fallback to latest Python platform in region.
  local arn
  arn="$(aws elasticbeanstalk list-platform-versions \
    --filters "Type=PlatformName,Operator=contains,Values=Python" "Type=PlatformBranchName,Operator=contains,Values=Amazon Linux 2023" \
    --region "${AWS_REGION}" \
    --query "PlatformSummaryList | sort_by(@, &PlatformVersion) | [-1].PlatformArn" \
    --output text 2>/dev/null || true)"

  if [[ -z "${arn}" || "${arn}" == "None" ]]; then
    arn="$(aws elasticbeanstalk list-platform-versions \
      --filters "Type=PlatformName,Operator=contains,Values=Python" \
      --region "${AWS_REGION}" \
      --query "PlatformSummaryList | sort_by(@, &PlatformVersion) | [-1].PlatformArn" \
      --output text 2>/dev/null || true)"
  fi

  if [[ -z "${arn}" || "${arn}" == "None" ]]; then
    echo "Could not resolve an Elastic Beanstalk Python platform in region ${AWS_REGION}." >&2
    echo "Run: aws elasticbeanstalk list-platform-versions --region ${AWS_REGION}" >&2
    exit 1
  fi
  echo "${arn}"
}

ensure_eb_app() {
  local app_exists
  app_exists="$(aws elasticbeanstalk describe-applications \
    --application-names "${APP_NAME}" \
    --region "${AWS_REGION}" \
    --query "Applications[0].ApplicationName" \
    --output text 2>/dev/null || true)"
  if [[ -z "${app_exists}" || "${app_exists}" == "None" ]]; then
    echo "Creating EB application ${APP_NAME}..."
    aws elasticbeanstalk create-application \
      --application-name "${APP_NAME}" \
      --region "${AWS_REGION}" >/dev/null
  else
    echo "EB application exists: ${APP_NAME}"
  fi
}

wait_env_ready() {
  local env_name="$1"
  local max_checks=60
  local sleep_s=10
  local i=0
  while (( i < max_checks )); do
    local status health
    status="$(aws elasticbeanstalk describe-environments \
      --application-name "${APP_NAME}" \
      --environment-names "${env_name}" \
      --region "${AWS_REGION}" \
      --query "Environments[0].Status" \
      --output text 2>/dev/null || true)"
    health="$(aws elasticbeanstalk describe-environments \
      --application-name "${APP_NAME}" \
      --environment-names "${env_name}" \
      --region "${AWS_REGION}" \
      --query "Environments[0].Health" \
      --output text 2>/dev/null || true)"

    if [[ "${status}" == "Ready" ]]; then
      echo "Environment ${env_name} is Ready (health: ${health})."
      return 0
    fi

    if [[ -z "${status}" || "${status}" == "None" || "${status}" == "Terminated" ]]; then
      echo "Environment ${env_name} not in updatable state (status: ${status})."
      return 1
    fi

    i=$((i + 1))
    echo "Waiting for ${env_name} to become Ready... (status: ${status}, health: ${health}, check ${i}/${max_checks})"
    sleep "${sleep_s}"
  done
  echo "Timed out waiting for ${env_name} to become Ready."
  return 1
}

upload_and_create_app_version() {
  local label="$1"
  local bundle="$2"

  local bucket
  bucket="$(aws elasticbeanstalk create-storage-location --region "${AWS_REGION}" --query "S3Bucket" --output text)"
  local key="${APP_NAME}/${label}.zip"
  aws s3 cp "${ROOT_DIR}/${bundle}" "s3://${bucket}/${key}" --region "${AWS_REGION}" >/dev/null

  aws elasticbeanstalk create-application-version \
    --application-name "${APP_NAME}" \
    --version-label "${label}" \
    --source-bundle "S3Bucket=${bucket},S3Key=${key}" \
    --region "${AWS_REGION}" >/dev/null
}

create_or_update_env() {
  local env_name="$1"
  local version_label="$2"
  local option_file="$3"
  local platform_arn="$4"

  local env_exists
  env_exists="$(aws elasticbeanstalk describe-environments \
    --application-name "${APP_NAME}" \
    --environment-names "${env_name}" \
    --region "${AWS_REGION}" \
    --query "Environments[0].EnvironmentName" \
    --output text 2>/dev/null || true)"

  if [[ -z "${env_exists}" || "${env_exists}" == "None" ]]; then
    echo "Creating environment ${env_name}..."
    aws elasticbeanstalk create-environment \
      --application-name "${APP_NAME}" \
      --environment-name "${env_name}" \
      --platform-arn "${platform_arn}" \
      --version-label "${version_label}" \
      --option-settings "file://${option_file}" \
      --region "${AWS_REGION}" >/dev/null
  else
    wait_env_ready "${env_name}"
    echo "Updating environment ${env_name}..."
    aws elasticbeanstalk update-environment \
      --environment-name "${env_name}" \
      --version-label "${version_label}" \
      --option-settings "file://${option_file}" \
      --region "${AWS_REGION}" >/dev/null
  fi
}

write_option_settings() {
  local qurl
  qurl="$(queue_url)"

  local edge_json cloud_json
  edge_json="$(mktemp)"
  cloud_json="$(mktemp)"

  cat > "${edge_json}" <<EOF
[
  {"Namespace":"aws:autoscaling:launchconfiguration","OptionName":"IamInstanceProfile","Value":"${EB_EC2_INSTANCE_PROFILE}"},
  {"Namespace":"aws:elasticbeanstalk:environment","OptionName":"ServiceRole","Value":"${EB_SERVICE_ROLE}"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"SQS_QUEUE_URL","Value":"${qurl}"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"AWS_REGION","Value":"${AWS_REGION}"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"RACK_ID","Value":"${RACK_ID}"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"RACK_IDS","Value":"${RACK_IDS}"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"DATACENTER_ID","Value":"${DATACENTER_ID}"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"SENSOR_FREQUENCY","Value":"${SENSOR_FREQUENCY}"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"DISPATCH_RATE","Value":"${DISPATCH_RATE}"}
]
EOF

  cat > "${cloud_json}" <<EOF
[
  {"Namespace":"aws:autoscaling:launchconfiguration","OptionName":"IamInstanceProfile","Value":"${EB_EC2_INSTANCE_PROFILE}"},
  {"Namespace":"aws:elasticbeanstalk:environment","OptionName":"ServiceRole","Value":"${EB_SERVICE_ROLE}"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"DYNAMODB_TABLE_NAME","Value":"${TABLE_NAME}"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"AWS_REGION","Value":"${AWS_REGION}"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"RACK_ID","Value":"${RACK_ID}"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"RACK_IDS","Value":"${RACK_IDS}"}
]
EOF

  echo "${edge_json}|${cloud_json}"
}

deploy_apps() {
  require_create_vars
  require_region

  ensure_eb_app
  local platform_arn
  platform_arn="$(resolve_platform_arn)"
  echo "Using EB platform: ${platform_arn}"
  package_zip "edge_app" "edge-bundle.zip"
  package_zip "cloud_app" "cloud-bundle.zip"

  local stamp edge_label cloud_label
  stamp="$(date +%Y%m%d-%H%M%S)"
  edge_label="edge-${stamp}"
  cloud_label="cloud-${stamp}"

  upload_and_create_app_version "${edge_label}" "edge-bundle.zip"
  upload_and_create_app_version "${cloud_label}" "cloud-bundle.zip"

  local files edge_file cloud_file
  files="$(write_option_settings)"
  edge_file="${files%%|*}"
  cloud_file="${files##*|}"

  create_or_update_env "${EDGE_ENV_NAME}" "${edge_label}" "${edge_file}" "${platform_arn}"
  create_or_update_env "${CLOUD_ENV_NAME}" "${cloud_label}" "${cloud_file}" "${platform_arn}"

  rm -f "${edge_file}" "${cloud_file}"

  echo "Deployment submitted."
  echo "Edge env:  ${EDGE_ENV_NAME}"
  echo "Cloud env: ${CLOUD_ENV_NAME}"
}

destroy_all() {
  require_region
  echo "About to delete resources in ${AWS_REGION}:"
  echo "  EB app: ${APP_NAME}"
  echo "  EB envs: ${EDGE_ENV_NAME}, ${CLOUD_ENV_NAME}"
  echo "  Lambda: ${LAMBDA_NAME}"
  echo "  SQS: ${QUEUE_NAME}"
  echo "  DynamoDB: ${TABLE_NAME}"
  read -r -p "Type DELETE to continue: " confirm
  if [[ "${confirm}" != "DELETE" ]]; then
    echo "Cancelled."
    exit 1
  fi

  local qarn qurl
  qarn="$(queue_arn)"
  qurl="$(queue_url)"

  if [[ -n "${qarn}" ]]; then
    local map_uuids
    map_uuids="$(aws lambda list-event-source-mappings \
      --function-name "${LAMBDA_NAME}" \
      --event-source-arn "${qarn}" \
      --region "${AWS_REGION}" \
      --query "EventSourceMappings[].UUID" \
      --output text 2>/dev/null || true)"
    for uuid in ${map_uuids}; do
      aws lambda delete-event-source-mapping --uuid "${uuid}" --region "${AWS_REGION}" >/dev/null || true
    done
  fi

  aws elasticbeanstalk terminate-environment --environment-name "${EDGE_ENV_NAME}" --terminate-resources --region "${AWS_REGION}" >/dev/null 2>&1 || true
  aws elasticbeanstalk terminate-environment --environment-name "${CLOUD_ENV_NAME}" --terminate-resources --region "${AWS_REGION}" >/dev/null 2>&1 || true
  aws elasticbeanstalk delete-application --application-name "${APP_NAME}" --terminate-env-by-force --region "${AWS_REGION}" >/dev/null 2>&1 || true

  aws lambda delete-function --function-name "${LAMBDA_NAME}" --region "${AWS_REGION}" >/dev/null 2>&1 || true

  if [[ -n "${qurl}" ]]; then
    aws sqs delete-queue --queue-url "${qurl}" --region "${AWS_REGION}" >/dev/null || true
  fi

  aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
  echo "Delete commands submitted. Some resources may take a few minutes to disappear."
}

create_all() {
  require_create_vars
  create_queue
  create_table
  create_or_update_lambda
  deploy_apps
}

main() {
  need_cmd aws
  need_cmd zip

  local cmd="${1:-}"
  case "${cmd}" in
    destroy) destroy_all ;;
    create) create_all ;;
    deploy) deploy_apps ;;
    all) destroy_all; create_all ;;
    *)
      echo "Usage: $0 {destroy|create|deploy|all}"
      exit 1
      ;;
  esac
}

main "$@"
