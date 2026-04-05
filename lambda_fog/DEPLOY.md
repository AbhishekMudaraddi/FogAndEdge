# Fog Lambda deployment notes

## Package

1. Create a zip **from inside** `lambda_fog/` so `lambda_function.py` is at the zip root (same as AWS console default).
2. Runtime: Python 3.12 (or match your account default).
3. Handler: `lambda_function.lambda_handler`.
4. Environment variable: `DYNAMODB_TABLE_NAME` (table name only; region from Lambda config).

## IAM (least privilege sketch)

- `dynamodb:PutItem`, `dynamodb:BatchWriteItem` on the table ARN.
- `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on the queue ARN (managed by event source mapping).

## Trigger

Add an SQS trigger to the queue (batch size 1–10 as preferred). Ensure DLQ optional for coursework.

## TTL

On the DynamoDB table, enable TTL on attribute name `expiry_timestamp` (Number, Unix epoch seconds).
