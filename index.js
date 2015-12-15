var https = require('https');
var querystring = require('querystring');
var util = require('util');
var aws = require('aws-sdk');
var cloudwatch = new aws.CloudWatch();

/****************************** Input ******************************/

// These must be hardcoded for now.  In the future we can pick them up from S3 or KeyManagementService.
var PINGDOM_USERNAME = '';
var PINGDOM_PASSWORD = '';

/**
 * Return  a hashmap with configuration for the entire application.
**/
generateParams = function(input) {
    var timeRange = minutesBetween(15, 1);
    
    return {
        credentials: {
            pingdomUsername: PINGDOM_USERNAME,
            pingdomPassword: PINGDOM_PASSWORD,
            // The App Key is not meant to be confidential, it should uniquely identify this script to Pingdom.com.
            pingdomAppkey: 'pqi5hajhsks159ijde71gktqdq3x16sh'
        },
        cwNamespace: 'PingdomToCloudWatchImporter',
        startTime: timeRange.start,
        endTime: timeRange.end
    };
};

/****************************** Date/Time Helpers ******************************/

/**
 * Return a new date that represents the time at the beginning of the minute represented
 * by the provided date.
**/
beginningOfMinute = function(date) {
    var newDate = new Date(date);
    newDate.setMilliseconds(0);
    newDate.setSeconds(0);
    return newDate;
};

/**
 * Return a new date that represents the time at the end of the minute represented
 * by the provided date.
**/
endOfMinute = function(date) {
    var newDate = beginningOfMinute(date);
    newDate.setMinutes(newDate.getMinutes() + 1);
    newDate.setMilliseconds(-1);
    return newDate;
};

/**
 * Return all the minutes between startMinutesAgo and endMinutesAgo.
**/
minutesBetween = function(startMinutesAgo, endMinutesAgo) {
    if (endMinutesAgo >= startMinutesAgo) {
        throw new Error('endMinutesAgo (' + endMinutesAgo + ') must be smaller than startMinutesAgo (' + startMinutesAgo + ').');
    }
    var currentTime = beginningOfMinute(new Date());
    currentTime.setMinutes(currentTime.getMinutes() - endMinutesAgo);
    
    var buckets = [];
    for (; startMinutesAgo > endMinutesAgo; startMinutesAgo--) {
        buckets.push(new Date(currentTime));
        currentTime.setMinutes(currentTime.getMinutes() - 1);
    }
    buckets = buckets.reverse();
    return {
        buckets: buckets,
        start: buckets[0],
        end: buckets[buckets.length - 1]
    };
};

/****************************** Misc Helpers ******************************/

/**
 * Return true if the given array contains the given element, false otherwise.
**/
arrayContains = function(array, element) {
    return array.indexOf(element) != -1;
};

/****************************** Pingdom Helpers ******************************/

/**
 * Invoke a Pingdom.com API.
 * apiName: name of the API to invoke
 * parameters: object of the API parameters, { param1: "value1", param2: "value2" }.
 * credentials: A map containing pingdomUsername, pingdomPassword, and pingdomAppkey.
 * failureCallback: a function(errorMessage) to invoke on failure.
 * successCallback: a function(jsonResponse) to invoke on success.
**/
invokePingdomAPI = function(apiName, parameters, credentials, failureCallback, successCallback) {
    var path = '/api/2.0/' + apiName;
    if (Object.keys(parameters).length > 0) {
        path += '?' + querystring.stringify(parameters);
    }
    var options = {
        host: 'api.pingdom.com',
        path: path,
        auth: credentials.pingdomUsername + ':' + credentials.pingdomPassword,
        headers: {
            'App-Key': credentials.pingdomAppkey,
        }
    };
    var request = https.request(options, function(response) {
        var str = '';
        response.on('data', function(chunk) {
            str += chunk;
        });

        response.on('end', function() {
            if (response.statusCode != '200') {
                failureCallback('Bad response upon invoking Pingdom API \'' + apiName + '\': ' + str);
            } else {
                successCallback(JSON.parse(str));
            }
        });
    });
    request.on('error', function(e) {
        failureCallback('Unable to invoke Pingdom API \'' + apiName + '\': ' + e.message);
    });
    request.end();
};

/****************************** AWS CloudWatch Helpers  ******************************/

/**
 * Create a Cloudwatch 'MetricData' object that represents an Availabilty metric for the given input.
 * checkName: Pingdom checkName.
 * time: Timestamp.
 * value: true if available, false otherwise.
**/
cwCreateAvailabilityMetricData = function(checkName, time, value) {
    return {
        MetricName: checkName + '-Availability',
        Timestamp: time,
        Value: value? 100 : 0,
        Unit: "Percent"
    };
};

/**
 * Create a Cloudwatch 'MetricData' object that represents a Latency metric for the given input.
 * checkName: Pingdom checkName.
 * time: Timestamp.
 * value: Latency (in milliseconds).
**/
cwCreateLatencyMetricData = function(checkName, time, value) {
    return {
        MetricName: checkName + '-Latency',
        Timestamp: time,
        Value: value,
        Unit: "Milliseconds"
    };
};

/**
 * Fetch data for an availabilty metric from Cloudwatch.
 * cwNamespace: The Cloudwatch Namepace.
 * checkName: Name of the check to fetch.
 * startTime: Start of time to fetch data for.
 * endTime: End of time to fetch data for.
 * failureCallback: a function(errorMessage) to invoke on failure.
 * successCallback: a function(jsonResponse) to invoke on success.
**/
cwGetAvailabilityMetric = function(cwNamespace, checkName, startTime, endTime, failureCallback, successCallback) {
    cloudwatch.getMetricStatistics({
        Namespace: cwNamespace,
        MetricName: checkName + '-Availability',
        Period: 60,
        StartTime: startTime,
        EndTime: endTime,
        Statistics: ['SampleCount'],
        Unit: 'Percent'
    }, function(err, data) {
        if (err) failureCallback('Unable to fetch existing availability data from Cloudwatch: ' + err);
        else successCallback(data);
    });
};

/**
 * Put the given MetricData array into Cloudwatch.
 * cwNamespace: The Cloudwatch Namepace.
 * metricData: An array for Cloudwatch MetricData objects.
 * failureCallback: a function(errorMessage) to invoke on failure.
 * successCallback: a function() to invoke on success.
**/
var cwMaxPutDatapoints = 20;
cwPutMetricData = function(cwNamespace, metricData, failureCallback, successCallback) {
    // If there's not data to put, just invoke the successCallback().  This behavior is mainly
    // to make the main method a little cleaner.
    if (metricData.length === 0) {
        successCallback();
    }
    
    // PutMetricData() only accepts a limited number of datapoints, so slice the array.
    var slicesNecessary = Math.ceil(metricData.length / cwMaxPutDatapoints), slicesCompleted = 0;
    for (var i = 0, l = metricData.length; i < l; i += cwMaxPutDatapoints) {
        var slice = metricData.slice(i, i + cwMaxPutDatapoints);
        var result = cloudwatch.putMetricData({
            Namespace: cwNamespace,
            MetricData: slice
        }, function(err, data) {
            if (err) failureCallback('Unable to put data into CloudWatch: ' + err);
            else slicesCompleted++;
        });
    }
    
    // Wait for all the slices to complete.
    var waiter = setInterval(function() {
        if (slicesCompleted == slicesNecessary) {
            clearInterval(waiter);
            successCallback();
        }
    }, 50);
};

/****************************** Progress Observer  ******************************/

/**
 * This is a utility class that allows us to keep track of all the check processing and
 * know when it is complete (so the main method can call context.succeed).
**/
function ProgressObserver() {
    this.started = false;
    this.observing = {};
}

ProgressObserver.prototype.start = function() {
    this.started = true;
};

ProgressObserver.prototype.observe = function(name) {
    this.observing[name] = 'in-progress';
};

ProgressObserver.prototype.complete = function(name) {
    if (!this.observing[name]) {
        throw new Error('Cannot complete observation for: ' + name + ' . We were never asked to begin observing it.');
    }
    this.observing[name] = 'completed';
};

ProgressObserver.prototype.fail = function(name) {
    if (!this.observing[name]) {
        throw new Error('Cannot fail observation for: ' + name + ' . We were never asked to begin observing it.');
    }
    this.observing[name] = 'failed';
};

/**
 * Wait for all observed events to complete.
 * callback: a function(succeeded, failed) to invoke on success.
**/
ProgressObserver.prototype.waitForCompletion = function(callback) {
    var progressObserver = this;
    var waiter = setInterval(function() {
        
        // If .start() hasn't been called, this means .observe() hasn't yet been called
        // on everything.  So we're definitely not done.
        if (!progressObserver.started) {
            return;
        }
        
        // Count what is in-progress, completed, and failed.
        var inProgress = [];
        var completed = [];
        var failed = [];
        Object.keys(progressObserver.observing).forEach(function(entry) {
            if (progressObserver.observing[entry] == 'in-progress') {
                inProgress.push(entry);
            } else if (progressObserver.observing[entry] == 'completed') {
                completed.push(entry);
            } else if (progressObserver.observing[entry] == 'failed') {
                failed.push(entry);
            }
        });
        
        // If nothing is in-progress, we're done.
        if (inProgress.length === 0) {
            clearInterval(waiter);
            callback(completed, failed);
        }
    }, 50);
};

/****************************** Main  ******************************/

/**
 * Main method, drive the entire Lambda function.
**/
exports.handler = function(event, context) {
    var input = generateParams();
    console.log("Processing time-range from: " + input.startTime + " to: " + input.endTime);

    // This on-failure handler will abort the entire lambda function.
    var globalAbort = function(message) {
        context.fail('Aborting, fatal error: ' + message);
    };
    
    var progressObserver = new ProgressObserver();
    
    // First, describe all of the available checks from Pingdom.
    invokePingdomAPI('checks', {}, input.credentials, globalAbort, function(response) {
        response.checks.forEach(function(check) {
			var checkName = check.name + '-' + check.id;
            if (check.resolution != 1) {
                console.log(checkName + ' Skipping check, the resolution is ' + check.resolution + ' minutes.');
            } else {
                console.log(checkName + ' Processing.');
                progressObserver.observe(checkName);
                
                var failCheck = function(message) {
                    console.log(checkName + ' Failed: ' + message);
                    progressObserver.fail(checkName);
                };
                
                // Fetch existing data for this check in Cloudwatch.
                cwGetAvailabilityMetric(input.cwNamespace, checkName, input.startTime, input.endTime, failCheck, function(data) {
                    // Keep note of which time buckets we already have data for.
                    var existingCloudwatchData = [];
                    data.Datapoints.forEach(function(datapoint) {
                        existingCloudwatchData.push(new Date(datapoint.Timestamp).toISOString());
                    });
     
                    // Now, fetch the  results for this check from Pingdom.
                    invokePingdomAPI('results/' + check.id, {
                        from: Math.round(input.startTime.getTime() / 1000),
                        to: Math.round(endOfMinute(input.endTime).getTime() / 1000)
                    }, input.credentials, failCheck, function(response) {
                        // Hold all the Cloudwatch data that we want to put, we'll do it in one batch.
                        var cwMetricDataToPut = [];
                            
                        response.results.forEach(function(result) {
                            var time = beginningOfMinute(new Date(result.time * 1000));
                            var up = result.status == 'up';
                            var latency = result.responsetime;
                                
                            // If Cloudwatch already had data for this time bucket, don't add any more.
                            if (!arrayContains(existingCloudwatchData, time.toISOString())) {
                                console.log(checkName + ' Putting metrics into Cloudwatch for ' + time + ': ' + up + ', ' + latency);
                                cwMetricDataToPut.push(cwCreateAvailabilityMetricData(checkName, time, up));
                                cwMetricDataToPut.push(cwCreateLatencyMetricData(checkName, time, latency));
                            } else {
                                console.log(checkName + ' Data already found in Cloudwatch for ' + time + '.');
                            }
                        });
                        
                        // Finally, put the data into Cloudwatch.
                        cwPutMetricData(input.cwNamespace, cwMetricDataToPut, failCheck, function() {
                            console.log(checkName + ' Successfully processed.');
                            progressObserver.complete(checkName);
                        });
                    });
                });
            }
        });
        progressObserver.start();
    });
    
    progressObserver.waitForCompletion(function(completed, failed) {
        if (failed.length > 0) {
            context.fail('The following checks failed: ' + util.inspect(failed));
        } else {
            context.succeed(completed.length + ' check(s) successfully processed.');
        }
    });
};