import { VisualElementNode, VisualLogicNode, VisualExprNode, VisualTextNode, VisualOptionsNode, VisualNodeIntl } from '../../interfaces';

export const isElementNode = function isElementNode(node: VisualNodeIntl): node is VisualElementNode {
  return node.type === 'element';
}

export const isLogicNode = function isLogicNode(node: VisualNodeIntl): node is VisualLogicNode {
  return node.type === 'logic';
}

export const isExprNode = function isExprNode(node: VisualNodeIntl): node is VisualExprNode {
  return node.type === 'expr';
}

export const isTextNode = function isTextNode(node: VisualNodeIntl): node is VisualTextNode {
  return node.type === 'text';
}

export const isOptionsNode = function isOptionsNode(node: VisualNodeIntl): node is VisualOptionsNode {
  return node.type === 'options';
}
