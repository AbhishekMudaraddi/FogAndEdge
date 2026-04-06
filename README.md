# Fog-Enabled Data Center Thermal Monitoring and Predictive Cooling

Three-tier demo: **edge** (Flask on EB) → **SQS** → **fog** (Lambda) → **DynamoDB** → **cloud** (Flask dashboard on EB).

No AWS IoT / MQTT.

## Repository layout

| Path | Role |
|------|------|
| `edge_app/` | Virtual sensor simulator; publishes batches to SQS |
| `lambda_fog/` | Lambda handler; fog enrichment + DynamoDB `batch_writer` |
| `cloud_app/` | REST API + HTML/CSS/JS dashboard (3s live polling) |

## Local testing (before AWS)

Use a **virtualenv** (macOS Homebrew Python blocks global `pip install`).

### One-time setup

```bash
cd /path/to/FNEproject
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r edge_app/requirements.txt
pip install -r cloud_app/requirements.txt
```

### A) Dashboard only — mock data (fastest)

Runs the same HTML/CSS/JS and REST routes, but **no DynamoDB**. Data is regenerated on each request so charts move every ~3 seconds.

```bash
source .venv/bin/activate
export MOCK_DYNAMODB=1
python cloud_app/application.py
```

Open [http://127.0.0.1:5001/](http://127.0.0.1:5001/). Check [http://127.0.0.1:5001/health](http://127.0.0.1:5001/health) — you should see `"mock_dynamodb": true`.

### B) Edge simulator only (JSON + optional SQS)

```bash
source .venv/bin/activate
python edge_app/application.py
```

- [http://127.0.0.1:5000/](http://127.0.0.1:5000/) — health JSON  
- [http://127.0.0.1:5000/debug/last-batch](http://127.0.0.1:5000/debug/last-batch) — **exact payload** shape sent to SQS (5 readings)

If `SQS_QUEUE_URL` is **unset**, the worker still runs but **skips** sending (log line: skipping publish). To send for real, configure AWS credentials and set `SQS_QUEUE_URL`.

### C) Full chain on AWS (after you integrate)

1. Create SQS queue + DynamoDB table + Lambda + TTL (see below).  
2. Deploy/run **edge** with `SQS_QUEUE_URL` and an IAM role/user that can `sqs:SendMessage`.  
3. Confirm messages are consumed and items appear in DynamoDB.  
4. Run **cloud** with `DYNAMODB_TABLE_NAME`, **unset** `MOCK_DYNAMODB`, and IAM that can `dynamodb:Query` on that table.  
5. Open the cloud EB URL (or local with env vars pointing at AWS).

**Lambda quick manual test:** In the Lambda console, use a test event shaped like API Gateway **or** an SQS event with one `Records` entry whose `body` is a JSON string of an array of five reading objects (same shape as `/debug/last-batch`).

## DynamoDB table

- **Partition key:** `rack_id` (String)
- **Sort key:** `sensor_timestamp` (String), format `sensor_type#ISO8601` (unique per reading, queryable with `begins_with`)
- **TTL:** enable on attribute `expiry_timestamp` (Number, Unix epoch seconds)

## Environment variables

**Edge (`edge_app`):**

- `SQS_QUEUE_URL` — target queue URL
- `AWS_REGION` — region for SQS client
- `RACK_ID` — default `rack_01`
- `DATACENTER_ID` — default `DC-01`
- `SENSOR_FREQUENCY` — seconds between simulated cycles (default `1`)
- `DISPATCH_RATE` — publish every N cycles (default `1`)

**Lambda (`lambda_fog`):**

- `DYNAMODB_TABLE_NAME`

**Cloud (`cloud_app`):**

- `DYNAMODB_TABLE_NAME` — required unless `MOCK_DYNAMODB=1`
- `MOCK_DYNAMODB` — set to `1` / `true` for local UI testing without DynamoDB
- `AWS_REGION`
- `RACK_ID` — must match data ingested for that rack

## Elastic Beanstalk zip packaging

Build the zip **from inside** the app folder so `application.py` is at the **root** of the zip:

```bash
cd edge_app
zip -r ../edge-eb.zip . -x "*.pyc" -x "__pycache__/*"
```

Repeat with `cloud_app` for the dashboard environment.

Upload the zip in the EB console (or CLI). Ensure the platform is **Python** and the Procfile is included.

## AWS setup (step-by-step)

1. **SQS:** Create a standard queue. Note the queue URL for `SQS_QUEUE_URL`.
2. **DynamoDB:** Create table with keys above. Turn on **TTL** on `expiry_timestamp`.
3. **IAM for Lambda:** Role with `dynamodb:PutItem` and `dynamodb:BatchWriteItem` on the table ARN; event source mapping adds SQS poll permissions on the queue.
4. **Lambda:** Create function from `lambda_fog/lambda_function.py`, set handler `lambda_function.lambda_handler`, env `DYNAMODB_TABLE_NAME`, add SQS trigger.
5. **IAM for EB instances (edge):** Instance profile allowing `sqs:SendMessage` on the queue ARN.
6. **IAM for EB instances (cloud):** Instance profile allowing `dynamodb:Query` (and optionally `dynamodb:DescribeTable`) on the table ARN.
7. **Two EB environments:** Create **one** Elastic Beanstalk **application** (e.g. `dc-thermal`) and **two environments** inside it (e.g. `dc-thermal-edge` and `dc-thermal-cloud`). Pick a supported Python platform in your region (Amazon Linux 2023). This repo does **not** pin `runtime.txt`, so deployments follow the EB environment platform version directly.

## GitHub Actions — deploy on every push

Workflow file: [`.github/workflows/deploy-aws.yml`](.github/workflows/deploy-aws.yml).

It runs on pushes to `main` or `master`, and can be run manually (**Actions → Deploy to AWS → Run workflow**).

### 1. Push the repo to GitHub

```bash
cd /path/to/FNEproject
git init
git add .
git commit -m "Initial thermal monitoring stack"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

### 2. Add repository secrets

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Purpose |
|--------|--------|
| `AWS_ACCESS_KEY_ID` | IAM user (or access key) for CI deploy |
| `AWS_SECRET_ACCESS_KEY` | Matching secret key |
| `AWS_REGION` | e.g. `us-east-1` |
| `EB_APPLICATION_NAME` | Elastic Beanstalk application name (exact match) |
| `EB_EDGE_ENVIRONMENT_NAME` | Environment that runs **edge_app** |
| `EB_CLOUD_ENVIRONMENT_NAME` | Environment that runs **cloud_app** |
| `FOG_LAMBDA_FUNCTION_NAME` | *(Optional)* Lambda function name; if omitted, the Lambda job skips |
| `SQS_QUEUE_URL` | Used to auto-sync edge env vars on each push |
| `DYNAMODB_TABLE_NAME` | Used to auto-sync cloud env vars on each push |
| `RACK_ID` | Optional override (default `rack_01`) |
| `RACK_IDS` | Optional override (default `rack_01,rack_02,rack_03`) |
| `DATACENTER_ID` | Optional override (default `DC-01`) |
| `SENSOR_FREQUENCY` | Optional override (default `30`) |
| `DISPATCH_RATE` | Optional override (default `1`) |

If you use temporary credentials (e.g. assumed role), extend the workflow to pass `aws_session_token` / OIDC; long‑lived access keys do not need a session token.

### 3. IAM permissions for the deploy user (CI)

Grant the user whose keys you stored **at least** (tighten ARNs for coursework “least privilege”):

- **Elastic Beanstalk:** `CreateApplicationVersion`, `UpdateEnvironment`, `Describe*`, `List*` on your app/environment.
- **S3:** `PutObject` (and related) on the Elastic Beanstalk staging bucket for your account/region (often named like `elasticbeanstalk-*` in that region).
- **Lambda (optional):** `lambda:UpdateFunctionCode`, `lambda:GetFunction`, `lambda:Wait` on `FOG_LAMBDA_FUNCTION_NAME`.

The **EC2 instance profile** attached to each EB environment is separate: edge needs SQS send; cloud needs DynamoDB query (see above).

### 4. Elastic Beanstalk environment properties (console)

After the first successful deploy, set **Configuration → Software → Environment properties** (names must match what the code reads).  
If you configured the secrets above, the workflow now auto-syncs these properties on every push.

**Edge environment**

- `SQS_QUEUE_URL`, `AWS_REGION`, `RACK_ID`, optional `DATACENTER_ID`, `SENSOR_FREQUENCY`, `DISPATCH_RATE`

**Cloud environment**

- `DYNAMODB_TABLE_NAME`, `AWS_REGION`, `RACK_ID` (same as edge)  
- Do **not** set `MOCK_DYNAMODB` in production (omit it or leave empty).

EB instances need an **instance profile** with the right permissions (SQS / DynamoDB). Redeploy or restart if you change env vars.

### 5. Live URLs

- **Dashboard:** open the **cloud** environment URL (CNAME) in a browser — that is your live HTML/CSS/JS UI.  
- **Edge health:** use the **edge** environment URL + `/` for JSON health and logs in EB to confirm SQS sends.

## API (cloud)

- `GET /` — dashboard
- `GET /api/sensors/<sensor_type>?n=50` — last N readings + small inline stats
- `GET /api/stats/<sensor_type>?m=100` — mean, min, max, stdev, count
- `GET /api/all-sensors` — latest row per sensor type (summary cards)

## Suggested order of next steps

1. **Local:** Run **A** (mock dashboard) and **B** (edge + `/debug/last-batch`) until the behavior is clear.  
2. **AWS foundation:** SQS queue → DynamoDB table + TTL on `expiry_timestamp`.  
3. **Fog:** Deploy Lambda from `lambda_fog/`, attach SQS trigger, set `DYNAMODB_TABLE_NAME`.  
4. **Edge on AWS:** EB environment for `edge_app`, instance profile with `sqs:SendMessage`, env `SQS_QUEUE_URL` + `RACK_ID`.  
5. **Cloud on AWS:** EB for `cloud_app`, instance profile with `dynamodb:Query`, env `DYNAMODB_TABLE_NAME` + `RACK_ID` (same as edge). Unset `MOCK_DYNAMODB`.  
6. **Coursework polish:** Dashboard layout, screenshots, IAM least-privilege write-up, optional SonarCloud.

## Next steps (coursework)

- Refine dashboard layout and styling (Flask templates + static assets only).
- Optional: SonarCloud analysis in a separate workflow.
