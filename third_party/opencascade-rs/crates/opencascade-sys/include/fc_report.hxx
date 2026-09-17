#pragma once
#include <Message_Alert.hxx>
#include <Message_Report.hxx>
#include <string>

// One alert key per line, prefixed by its gravity: W warning, A alarm, F fail.
inline std::string fc_report_alerts(const Handle(Message_Report) &report) {
  std::string out;
  if (report.IsNull()) {
    return out;
  }
  const Message_Gravity gravities[] = {Message_Warning, Message_Alarm, Message_Fail};
  const char tags[] = {'W', 'A', 'F'};
  for (int i = 0; i < 3; ++i) {
    for (Message_ListOfAlert::Iterator it(report->GetAlerts(gravities[i])); it.More(); it.Next()) {
      out += tags[i];
      out += ' ';
      out += it.Value()->GetMessageKey();
      out += '\n';
    }
  }
  return out;
}
