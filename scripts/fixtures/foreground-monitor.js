// Run with osascript -l JavaScript. Observes activation without controlling UI.
ObjC.import('AppKit');

function run(args) {
  var workspace = $.NSWorkspace.sharedWorkspace;
  var output = $.NSFileHandle.fileHandleWithStandardOutput;
  function write(event) {
    event.at = new Date().toISOString();
    output.writeData($(JSON.stringify(event) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
  }
  function application(app) {
    return { bundle: ObjC.unwrap(app.bundleIdentifier), pid: Number(app.processIdentifier) };
  }
  var selfTest = true;
  var observedSelfTest = false;
  var observer = workspace.notificationCenter.addObserverForNameObjectQueueUsingBlock(
    $.NSWorkspaceDidActivateApplicationNotification, null, $.NSOperationQueue.mainQueue,
    function(notification) {
      var app = notification.userInfo.objectForKey($.NSWorkspaceApplicationKey);
      if (selfTest) { observedSelfTest = true; return; }
      write({ event: 'activated', application: application(app) });
    }
  );
  // A local notification verifies the callback without activating any app.
  workspace.notificationCenter.postNotificationNameObjectUserInfo(
    $.NSWorkspaceDidActivateApplicationNotification, null,
    $({ NSWorkspaceApplicationKey: workspace.frontmostApplication })
  );
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  selfTest = false;
  write({ event: 'ready', selfTest: observedSelfTest, application: application(workspace.frontmostApplication) });
  var last = application(workspace.frontmostApplication).bundle;
  var samples = 0;
  var deadline = Date.now() + 900000;
  try {
    while (!$.NSFileManager.defaultManager.fileExistsAtPath($(args[0])) && Date.now() < deadline) {
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
      var current = application(workspace.frontmostApplication);
      samples++;
      if (current.bundle !== last) {
        write({ event: 'sample', application: current });
        last = current.bundle;
      }
    }
    write({ event: 'stopped', samples: samples, application: application(workspace.frontmostApplication) });
  } finally {
    workspace.notificationCenter.removeObserver(observer);
  }
}
