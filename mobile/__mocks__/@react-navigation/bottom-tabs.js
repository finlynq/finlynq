const React = require("react");

const createBottomTabNavigator = () => ({
  Navigator: ({ children, ...props }) =>
    React.createElement("TabNavigator", props, children),
  Screen: ({ children, ...props }) =>
    React.createElement("TabScreen", props, children),
});

module.exports = { createBottomTabNavigator };
