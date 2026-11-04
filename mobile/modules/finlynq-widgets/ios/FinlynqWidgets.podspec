Pod::Spec.new do |s|
  s.name           = 'FinlynqWidgets'
  s.version        = '1.0.0'
  s.summary        = 'The app side of the Finlynq home-screen widgets.'
  s.description    = 'Writes the snapshot the WidgetKit extension in targets/widget reads, in the App Group container.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Finlynq'
  s.homepage       = 'https://finlynq.com'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/finlynq/finlynq.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WidgetKit'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
