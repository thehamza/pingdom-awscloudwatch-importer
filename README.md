# pingdom-awscloudwatch-importer
This AWS Lambda function imports metrics from Pingdom to AWS CloudWatch.  It will automatically enumerate all checks for the specified Pingdom account and import Availability and Latency metrics for each check with 1-minute resolution.  To use:

* Create a IAM Role with an inline policy like the following:
```
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "Stmt1447637317000",
            "Effect": "Allow",
            "Action": [
                "cloudwatch:GetMetricStatistics",
                "cloudwatch:PutMetricData",
                "logs:*"
            ],
            "Resource": [
                "*"
            ]
        }
    ]
}
```

* Create an AWS Lambda function without using a Blueprint.
  * Leave the default handler as 'index.handler'
  * Associate the above role.
  * Consider increasing the timeout to at least 10 seconds (or more, depending on how many Pingdom checks you have).
* Paste in the content of /index.js into the Lambda function body and modify it to insert valid values for `PINGDOM_USERNAME` and `PINGDOM_PASSWORD`.
* Add a "Scheduled Event" Event Source for the Lambda function.  Run every 5 or 10 minutes.

You should see new Cloudwatch metrics begin to appear shortly.  As long as you have included the `logs:*` action in the role definition, log messages from the function should show up in Cloudwatch Logs.
